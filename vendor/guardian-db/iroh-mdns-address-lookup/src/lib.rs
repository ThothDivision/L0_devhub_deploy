//! An address lookup service that uses an mdns-like service to discover and lookup the addresses of local endpoints.
//!
//! This allows you to use an mdns-like swarm discovery service to find address information about endpoints that are on your local network, no relay or outside internet needed.
//! See the [`swarm-discovery`](https://crates.io/crates/swarm-discovery) crate for more details.
//!
//! When [`MdnsAddressLookup`] is enabled, it's possible to get a list of the locally discovered endpoints by filtering a list of `RemoteInfo`s.
//!
//! In order to get a list of locally discovered addresses, you must call `MdnsAddressLookup::subscribe` to subscribe
//! to a stream of discovered addresses.
//!
//! ```no_run
//! use iroh::{Endpoint, endpoint::presets};
//! use iroh_mdns_address_lookup::{DiscoveryEvent, MdnsAddressLookup};
//! use n0_future::StreamExt;
//!
//! #[tokio::main]
//! async fn main() {
//!     let endpoint = Endpoint::bind(presets::Minimal).await.unwrap();
//!
//!     // Register the Address Lookupwith the endpoint
//!     let mdns = MdnsAddressLookup::builder().build(endpoint.id()).unwrap();
//!     endpoint.address_lookup().unwrap().add(mdns.clone());
//!
//!     // Subscribe to the mdns discovery events
//!     let mut events = mdns.subscribe().await;
//!     while let Some(event) = events.next().await {
//!         match event {
//!             DiscoveryEvent::Discovered { endpoint_info, .. } => {
//!                 println!("MDNS discovered: {:?}", endpoint_info);
//!             }
//!             DiscoveryEvent::Expired { endpoint_id } => {
//!                 println!("MDNS expired: {endpoint_id}");
//!             }
//!             _ => {}
//!         }
//!     }
//! }
//! ```
//!
//! ## Filtering
//!
//! By default, [`MdnsAddressLookup`] publishes all addresses it receives:
//! direct IP addresses and up to one [`RelayUrl`]. The following constraints apply regardless
//! of any user-supplied filter:
//!
//! - Only the first [`RelayUrl`] in the address set is published.
//! - A [`RelayUrl`] longer than 249 bytes is silently dropped.
//!
//! You can supply an [`AddrFilter`] via [`MdnsAddressLookupBuilder::addr_filter`] to
//! control which addresses are published and in what order. The filter is applied before the
//! constraints above, so for example you can use it to exclude relay URLs entirely or to
//! prioritize certain addresses.
//!
//! [`AddrFilter`]: iroh::address_lookup::AddrFilter
//! [`RelayUrl`]: iroh_base::RelayUrl
use std::{
    collections::{BTreeSet, HashMap},
    net::{IpAddr, SocketAddr},
    str::FromStr,
    sync::{Arc, Mutex as StdMutex},
};

use iroh::{
    Endpoint,
    address_lookup::{
        AddrFilter, AddressLookup, AddressLookupBuilder, AddressLookupBuilderError, EndpointData,
        EndpointInfo, Error as AddressLookupError, Item as AddressLookupItem, UserData,
    },
};
use iroh_base::{EndpointId, PublicKey};
use n0_future::{
    Stream,
    boxed::BoxStream,
    task::{self, AbortOnDropHandle, JoinSet},
    time::{self, Duration},
};
use n0_watcher::{Watchable, Watcher as _};
use swarm_discovery::{Discoverer, DropGuard, IpClass, Peer};
use tokio::sync::{mpsc, watch};
use tracing::{Instrument, debug, error, info_span, trace, warn};

/// The n0 local service name.
const N0_SERVICE_NAME: &str = "irohv1";

/// Name of this address lookup service.
///
/// Used as the `provenance` field in [`AddressLookupItem`]s.
pub const NAME: &str = "mdns";

/// The key of the attribute under which the `UserData` is stored in
/// the TXT record supported by swarm-discovery.
const USER_DATA_ATTRIBUTE: &str = "user-data";

/// How long we will wait before we stop attempting to resolve an endpoint ID to an address.
const LOOKUP_DURATION: Duration = Duration::from_secs(10);

#[derive(Clone)]
struct DiscoveryFilter {
    predicate: Arc<dyn Fn(EndpointId, Option<&UserData>) -> bool + Send + Sync>,
}

impl std::fmt::Debug for DiscoveryFilter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DiscoveryFilter").finish_non_exhaustive()
    }
}

impl DiscoveryFilter {
    fn accepts(&self, endpoint_id: EndpointId, user_data: Option<&UserData>) -> bool {
        (self.predicate)(endpoint_id, user_data)
    }
}

/// The key of the attribute under which the `RelayUrl` is stored in
/// the TXT record supported by swarm-discovery.
const RELAY_URL_ATTRIBUTE: &str = "relay";

/// Address Lookup using `swarm-discovery`, a variation on mdns.
#[derive(Debug, Clone)]
pub struct MdnsAddressLookup {
    #[allow(dead_code)]
    handle: Arc<AbortOnDropHandle<()>>,
    sender: mpsc::Sender<Message>,
    discovered: DiscoveryState,
    advertise: bool,
    /// When `local_addrs` changes, we re-publish our info.
    local_addrs: Watchable<Option<EndpointData>>,
}

#[derive(Debug)]
enum Message {
    Resolve(
        EndpointId,
        mpsc::Sender<Result<AddressLookupItem, AddressLookupError>>,
    ),
    Timeout(EndpointId, usize),
}

#[derive(Debug, Clone)]
struct DiscoveryState {
    peers: Arc<StdMutex<HashMap<EndpointId, Peer>>>,
    generation: watch::Sender<u64>,
    max_peers: usize,
}

impl DiscoveryState {
    fn new(max_peers: usize) -> Self {
        let (generation, _) = watch::channel(0);
        Self {
            peers: Arc::new(StdMutex::new(HashMap::new())),
            generation,
            max_peers: max_peers.max(1),
        }
    }

    fn snapshot(&self) -> HashMap<EndpointId, Peer> {
        self.peers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn observe(
        &self,
        local_endpoint_id: EndpointId,
        endpoint_id: &str,
        peer: &Peer,
        filter: Option<&DiscoveryFilter>,
    ) {
        let endpoint_id = match PublicKey::from_str(endpoint_id) {
            Ok(endpoint_id) => endpoint_id,
            Err(error) => {
                warn!(
                    endpoint_id,
                    "couldn't parse endpoint_id from mDNS: {error:?}"
                );
                return;
            }
        };
        if endpoint_id == local_endpoint_id {
            return;
        }

        let user_data = peer_user_data(peer);
        let accepted = peer.is_expiry()
            || filter.is_none_or(|filter| filter.accepts(endpoint_id, user_data.as_ref()));
        if !accepted {
            debug!(%endpoint_id, "discovery filter rejected mDNS advertisement");
        }
        let changed = {
            let mut peers = self
                .peers
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if peer.is_expiry() || !accepted {
                peers.remove(&endpoint_id).is_some()
            } else if let Some(retained) = peers.get(&endpoint_id) {
                if same_advertisement(retained, peer) {
                    false
                } else {
                    peers.insert(endpoint_id, peer.clone());
                    true
                }
            } else if peers.len() < self.max_peers {
                peers.insert(endpoint_id, peer.clone());
                true
            } else {
                false
            }
        };
        if changed {
            self.generation.send_modify(|generation| {
                *generation = generation.wrapping_add(1);
            });
        }
    }

    fn subscribe(&self) -> watch::Receiver<u64> {
        self.generation.subscribe()
    }
}

/// Builder for [`MdnsAddressLookup`].
#[derive(Debug)]
pub struct MdnsAddressLookupBuilder {
    advertise: bool,
    service_name: String,
    filter: AddrFilter,
    user_data: Option<UserData>,
    discovery_filter: Option<DiscoveryFilter>,
    max_peers: usize,
}

impl MdnsAddressLookupBuilder {
    /// Creates a new [`MdnsAddressLookupBuilder`] with default settings.
    fn new() -> Self {
        Self {
            advertise: true,
            service_name: N0_SERVICE_NAME.to_string(),
            filter: AddrFilter::default(),
            user_data: None,
            discovery_filter: None,
            max_peers: 100,
        }
    }

    /// Sets whether this endpoint should advertise its presence.
    ///
    /// Default is true.
    pub fn advertise(mut self, advertise: bool) -> Self {
        self.advertise = advertise;
        self
    }

    /// Sets a custom service name.
    ///
    /// The default is `irohv1`, which will show up on a record in the
    /// following form, for example:
    /// `7rutqynuzu65fcdgoerbt4uoh3p62wuto2mp56x3uvhitqzssxga._irohv1._udp.local`
    ///
    /// Any custom service name will take the form, for example:
    /// `7rutqynuzu65fcdgoerbt4uoh3p62wuto2mp56x3uvhitqzssxga._{service_name}._udp.local`
    pub fn service_name(mut self, service_name: impl Into<String>) -> Self {
        self.service_name = service_name.into();
        self
    }

    /// Sets a filter to control which addresses are published by this service.
    pub fn addr_filter(mut self, filter: AddrFilter) -> Self {
        self.filter = filter;
        self
    }

    /// Overrides user data published by this mDNS provider only.
    pub fn user_data(mut self, user_data: UserData) -> Self {
        self.user_data = Some(user_data);
        self
    }

    /// Filters passive discoveries before they consume retained-map capacity.
    pub fn discovery_filter(
        mut self,
        predicate: impl Fn(EndpointId, Option<&UserData>) -> bool + Send + Sync + 'static,
    ) -> Self {
        self.discovery_filter = Some(DiscoveryFilter {
            predicate: Arc::new(predicate),
        });
        self
    }

    /// Caps the passively discovered endpoint state retained in memory.
    pub fn max_peers(mut self, max_peers: usize) -> Self {
        self.max_peers = max_peers.max(1);
        self
    }

    /// Builds an [`MdnsAddressLookup`] instance with the configured settings.
    ///
    /// # Errors
    /// Returns an error if the network does not allow ipv4 OR ipv6.
    ///
    /// # Panics
    /// This relies on [`tokio::runtime::Handle::current`] and will panic if called outside of the context of a tokio runtime.
    pub fn build(
        self,
        endpoint_id: EndpointId,
    ) -> Result<MdnsAddressLookup, AddressLookupBuilderError> {
        MdnsAddressLookup::new(
            endpoint_id,
            self.advertise,
            self.service_name,
            self.filter,
            self.user_data,
            self.discovery_filter,
            self.max_peers,
        )
    }
}

impl Default for MdnsAddressLookupBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl AddressLookupBuilder for MdnsAddressLookupBuilder {
    fn into_address_lookup(
        self,
        endpoint: &Endpoint,
    ) -> Result<impl AddressLookup, AddressLookupBuilderError> {
        self.build(endpoint.id())
    }
}

/// An event emitted from the [`MdnsAddressLookup`] service.
#[derive(Debug, Clone, Eq, PartialEq)]
#[non_exhaustive]
pub enum DiscoveryEvent {
    /// A peer was discovered or it's information was updated.
    Discovered {
        /// The endpoint info for the endpoint, as discovered.
        endpoint_info: EndpointInfo,
        /// Optional timestamp when this endpoint address info was last updated.
        last_updated: Option<u64>,
    },
    /// A peer was expired due to being inactive, unreachable, or otherwise
    /// unavailable.
    Expired {
        /// The id of the endpoint that expired.
        endpoint_id: EndpointId,
    },
}

impl MdnsAddressLookup {
    /// Returns a [`MdnsAddressLookupBuilder`] used to construct [`MdnsAddressLookup`].
    pub fn builder() -> MdnsAddressLookupBuilder {
        MdnsAddressLookupBuilder::default()
    }

    /// Create a new [`MdnsAddressLookup`] Service.
    ///
    /// This starts a [`Discoverer`] that broadcasts your addresses (if advertise is set to true)
    /// and receives addresses from other endpoints in your local network.
    ///
    /// # Errors
    /// Returns an error if the network does not allow ipv4 OR ipv6.
    ///
    /// # Panics
    /// This relies on [`tokio::runtime::Handle::current`] and will panic if called outside of the context of a tokio runtime.
    fn new(
        endpoint_id: EndpointId,
        advertise: bool,
        service_name: String,
        filter: AddrFilter,
        user_data: Option<UserData>,
        discovery_filter: Option<DiscoveryFilter>,
        max_peers: usize,
    ) -> Result<Self, AddressLookupBuilderError> {
        debug!("Creating new Mdns service");
        let (send, mut recv) = mpsc::channel(64);
        let task_sender = send.clone();
        let rt = tokio::runtime::Handle::current();
        let discovered = DiscoveryState::new(max_peers);
        let address_lookup = MdnsAddressLookup::spawn_discoverer(
            endpoint_id,
            advertise,
            discovered.clone(),
            discovery_filter,
            BTreeSet::new(),
            service_name,
            &rt,
        )?;

        let local_addrs: Watchable<Option<EndpointData>> = Watchable::default();
        let mut addrs_change = local_addrs.watch();
        let discovered_for_actor = discovered.clone();
        let mut discovered_change = discovered.subscribe();
        let address_lookup_fut = async move {
            let mut last_id = 0;
            let mut senders: HashMap<
                PublicKey,
                HashMap<usize, mpsc::Sender<Result<AddressLookupItem, AddressLookupError>>>,
            > = HashMap::default();
            let mut timeouts = JoinSet::new();
            loop {
                tokio::select! {
                    msg = recv.recv() => {
                        let Some(msg) = msg else {
                            error!("Mdns channel closed");
                            timeouts.abort_all();
                            address_lookup.remove_all();
                            return;
                        };
                        match msg {
                            Message::Resolve(endpoint_id, sender) => {
                                let snapshot = discovered_for_actor.snapshot();
                                if let Some(peer_info) = snapshot.get(&endpoint_id) {
                                    let item = peer_to_discovery_item(peer_info, &endpoint_id);
                                    debug!(?item, "sending AddressLookupItem");
                                    let _ = sender.try_send(Ok(item));
                                    continue;
                                }

                                let id = last_id + 1;
                                last_id = id;
                                senders.entry(endpoint_id).or_default().insert(id, sender);
                                let timeout_sender = task_sender.clone();
                                timeouts.spawn(async move {
                                    time::sleep(LOOKUP_DURATION).await;
                                    trace!(?endpoint_id, "resolution timeout");
                                    let _ = timeout_sender.send(Message::Timeout(endpoint_id, id)).await;
                                });
                            }
                            Message::Timeout(endpoint_id, id) => {
                                if let Some(waiters) = senders.get_mut(&endpoint_id) {
                                    waiters.remove(&id);
                                    if waiters.is_empty() {
                                        senders.remove(&endpoint_id);
                                    }
                                }
                            }
                        }
                    }
                    Ok(Some(data)) = addrs_change.updated() => {
                        tracing::trace!(?data, "Mdns address changed");
                        address_lookup.remove_all();
                        let data = data.apply_filter(&filter).into_owned();
                        let relay = data.relay_urls().next().map(ToString::to_string);
                        if let Err(error) = address_lookup.set_txt_attribute(
                            RELAY_URL_ATTRIBUTE.to_string(),
                            relay,
                        ) {
                            warn!("Failed to set the relay url in mDNS: {error:?}");
                        }
                        let announced_user_data = user_data
                            .as_ref()
                            .or_else(|| data.user_data())
                            .map(ToString::to_string);
                        if let Err(error) = address_lookup.set_txt_attribute(
                            USER_DATA_ATTRIBUTE.to_string(),
                            announced_user_data,
                        ) {
                            warn!("Failed to set the user-defined data in mDNS: {error:?}");
                        }
                        let addrs = MdnsAddressLookup::socketaddrs_to_addrs(data.ip_addrs());
                        for (port, ips) in addrs {
                            address_lookup.add(port, ips);
                        }
                    }
                    changed = discovered_change.changed() => {
                        if changed.is_err() {
                            timeouts.abort_all();
                            address_lookup.remove_all();
                            return;
                        }
                        let _ = *discovered_change.borrow_and_update();
                        let snapshot = discovered_for_actor.snapshot();
                        let mut ready: Vec<_> = senders
                            .keys()
                            .filter(|endpoint_id| snapshot.contains_key(*endpoint_id))
                            .copied()
                            .collect();
                        ready.sort_unstable_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
                        for endpoint_id in ready {
                            let Some(peer_info) = snapshot.get(&endpoint_id) else {
                                continue;
                            };
                            let item = peer_to_discovery_item(peer_info, &endpoint_id);
                            if let Some(waiters) = senders.remove(&endpoint_id) {
                                for sender in waiters.into_values() {
                                    let _ = sender.try_send(Ok(item.clone()));
                                }
                            }
                        }
                    }
                }
            }
        };
        let handle =
            task::spawn(address_lookup_fut.instrument(info_span!("swarm-discovery.actor")));
        Ok(Self {
            handle: Arc::new(AbortOnDropHandle::new(handle)),
            sender: send,
            discovered,
            advertise,
            local_addrs,
        })
    }

    /// Subscribe to discovered endpoints.
    pub async fn subscribe(&self) -> impl Stream<Item = DiscoveryEvent> + Unpin + use<> {
        let state = self.discovered.clone();
        let mut changes = state.subscribe();
        let (sender, recv) = mpsc::channel(20);
        task::spawn(async move {
            let mut delivered: HashMap<EndpointId, Peer> = HashMap::new();
            loop {
                let _ = *changes.borrow_and_update();
                let current = state.snapshot();

                let mut expired: Vec<_> = delivered
                    .keys()
                    .filter(|endpoint_id| !current.contains_key(*endpoint_id))
                    .copied()
                    .collect();
                expired.sort_unstable_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
                for endpoint_id in expired {
                    if sender
                        .send(DiscoveryEvent::Expired { endpoint_id })
                        .await
                        .is_err()
                    {
                        return;
                    }
                    delivered.remove(&endpoint_id);
                }

                let mut discovered: Vec<_> = current.keys().copied().collect();
                discovered.sort_unstable_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
                for endpoint_id in discovered {
                    let peer = &current[&endpoint_id];
                    if delivered
                        .get(&endpoint_id)
                        .is_some_and(|known| same_advertisement(known, peer))
                    {
                        continue;
                    }
                    let item = peer_to_discovery_item(peer, &endpoint_id);
                    if sender
                        .send(DiscoveryEvent::Discovered {
                            endpoint_info: item.endpoint_info().clone(),
                            last_updated: item.last_updated(),
                        })
                        .await
                        .is_err()
                    {
                        return;
                    }
                    delivered.insert(endpoint_id, peer.clone());
                }

                tokio::select! {
                    _ = sender.closed() => return,
                    changed = changes.changed() => {
                        if changed.is_err() {
                            return;
                        }
                    }
                }
            }
        });
        tokio_stream::wrappers::ReceiverStream::new(recv)
    }

    fn spawn_discoverer(
        endpoint_id: PublicKey,
        advertise: bool,
        discovered: DiscoveryState,
        discovery_filter: Option<DiscoveryFilter>,
        socketaddrs: BTreeSet<SocketAddr>,
        service_name: String,
        rt: &tokio::runtime::Handle,
    ) -> Result<DropGuard, AddressLookupBuilderError> {
        let callback = move |discovered_endpoint_id: &str, peer: &Peer| {
            trace!(
                discovered_endpoint_id,
                ?peer,
                "Received peer information from Mdns"
            );
            discovered.observe(
                endpoint_id,
                discovered_endpoint_id,
                peer,
                discovery_filter.as_ref(),
            );
        };
        let endpoint_id_str = data_encoding::BASE32_NOPAD
            .encode(endpoint_id.as_bytes())
            .to_ascii_lowercase();
        let mut discoverer = Discoverer::new_interactive(service_name, endpoint_id_str)
            .with_callback(callback)
            .with_ip_class(IpClass::Auto);
        if advertise {
            let addrs = MdnsAddressLookup::socketaddrs_to_addrs(socketaddrs.iter());
            for addr in addrs {
                discoverer = discoverer.with_addrs(addr.0, addr.1);
            }
        }
        discoverer
            .spawn(rt)
            .map_err(|e| AddressLookupBuilderError::from_err("mdns", e))
    }

    fn socketaddrs_to_addrs<'a>(
        socketaddrs: impl Iterator<Item = &'a SocketAddr>,
    ) -> HashMap<u16, Vec<IpAddr>> {
        let mut addrs: HashMap<u16, Vec<IpAddr>> = HashMap::default();
        for socketaddr in socketaddrs {
            addrs
                .entry(socketaddr.port())
                .and_modify(|a| a.push(socketaddr.ip()))
                .or_insert(vec![socketaddr.ip()]);
        }
        addrs
    }
}

fn same_advertisement(retained: &Peer, observed: &Peer) -> bool {
    retained.addrs() == observed.addrs() && retained.txt_attributes().eq(observed.txt_attributes())
}

fn peer_user_data(peer: &Peer) -> Option<UserData> {
    let attribute = peer.txt_attribute(USER_DATA_ATTRIBUTE)?;
    let value = attribute.as_ref()?;
    match value.parse() {
        Ok(data) => Some(data),
        Err(error) => {
            debug!("failed to parse user data from TXT attribute: {error}");
            None
        }
    }
}

fn peer_to_discovery_item(peer: &Peer, endpoint_id: &EndpointId) -> AddressLookupItem {
    let ip_addrs: BTreeSet<SocketAddr> = peer
        .addrs()
        .iter()
        .map(|(ip, port)| SocketAddr::new(*ip, *port))
        .collect();

    // Get the relay url from the resolved peer info. We expect an attribute that parses as
    // a `RelayUrl`. Otherwise, omit.
    let relay_url = if let Some(Some(relay_url)) = peer.txt_attribute(RELAY_URL_ATTRIBUTE) {
        match relay_url.parse() {
            Err(err) => {
                debug!("failed to parse relay url from TXT attribute: {err}");
                None
            }
            Ok(url) => Some(url),
        }
    } else {
        None
    };

    let user_data = peer_user_data(peer);

    let mut data = EndpointData::from(ip_addrs);
    if let Some(relay_url) = relay_url {
        data.add_relay_url(relay_url);
    }
    data.set_user_data(user_data);

    let endpoint_info = EndpointInfo::from_parts(*endpoint_id, data);
    AddressLookupItem::new(endpoint_info, NAME, None)
}

impl AddressLookup for MdnsAddressLookup {
    fn resolve(
        &self,
        endpoint_id: EndpointId,
    ) -> Option<BoxStream<Result<AddressLookupItem, AddressLookupError>>> {
        use futures_util::FutureExt;

        let (send, recv) = mpsc::channel(20);
        let address_lookup_sender = self.sender.clone();
        let stream = async move {
            address_lookup_sender
                .send(Message::Resolve(endpoint_id, send))
                .await
                .ok();
            tokio_stream::wrappers::ReceiverStream::new(recv)
        };
        Some(Box::pin(stream.flatten_stream()))
    }

    fn publish(&self, data: &EndpointData) {
        if self.advertise {
            self.local_addrs.set(Some(data.clone())).ok();
        }
    }
}
