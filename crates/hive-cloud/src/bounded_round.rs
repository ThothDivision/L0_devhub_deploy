//! A periodic fan-out round that never lasts as long as its slowest target.
//!
//! `join_all` over every target made each round as long as its SLOWEST
//! target: one powered-off seed's dial budget stretched fc-virginia's gossip
//! round to 25-33 s (2026-09-24), and one failing peer's two fallback-ceiling
//! probe samples stretched every health-probe round to ~33 s. A
//! [`BoundedRound`] runs each target in its own task and waits for THIS
//! round's targets only until a deadline. A target still running then is a
//! straggler: it keeps running under its in-flight flag (never dispatched
//! twice at once) and its result lands in whichever later round receives it
//! ([`BoundedRound::begin`] drains those first). Each task reports through a
//! [`Completion`] drop guard, so a task that panics or is dropped still clears
//! its flag. The gossip loop and the health prober both run on it.

use std::collections::HashSet;
use std::future::Future;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

/// One target's result: (round it was dispatched in, target key, value).
pub type Landed<T> = (u64, String, T);

/// Sends a target's result to its round exactly once — on
/// [`Completion::finish`], or with `T::default()` when the task is dropped or
/// panics first. Without it a panicking task would leave its target's
/// in-flight flag set forever and the target never dispatched again.
pub struct Completion<T: Default + Send + 'static> {
    tx: UnboundedSender<Landed<T>>,
    round: u64,
    target: String,
    sent: bool,
}

impl<T: Default + Send + 'static> Completion<T> {
    fn new(tx: UnboundedSender<Landed<T>>, round: u64, target: String) -> Self {
        Self {
            tx,
            round,
            target,
            sent: false,
        }
    }

    pub fn finish(mut self, value: T) {
        self.sent = true;
        let _ = self
            .tx
            .send((self.round, std::mem::take(&mut self.target), value));
    }
}

impl<T: Default + Send + 'static> Drop for Completion<T> {
    fn drop(&mut self) {
        if !self.sent {
            let _ = self
                .tx
                .send((self.round, std::mem::take(&mut self.target), T::default()));
        }
    }
}

/// Loop-owned fan-out state (single writer: the loop that owns it).
pub struct BoundedRound<T: Default + Send + 'static> {
    tx: UnboundedSender<Landed<T>>,
    rx: UnboundedReceiver<Landed<T>>,
    in_flight: HashSet<String>,
    /// Targets dispatched in the current round that have not reported yet.
    dispatched: HashSet<String>,
    round: u64,
}

impl<T: Default + Send + 'static> Default for BoundedRound<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T: Default + Send + 'static> BoundedRound<T> {
    pub fn new() -> Self {
        let (tx, rx) = unbounded_channel();
        Self {
            tx,
            rx,
            in_flight: HashSet::new(),
            dispatched: HashSet::new(),
            round: 0,
        }
    }

    /// Start the next round. Returns the stragglers of earlier rounds that
    /// landed since the last [`collect`](Self::collect), their flags already
    /// cleared so they are dispatched again this round.
    pub fn begin(&mut self) -> Vec<Landed<T>> {
        self.round += 1;
        self.dispatched.clear();
        let mut out = Vec::new();
        while let Ok(landed) = self.rx.try_recv() {
            self.in_flight.remove(&landed.1);
            out.push(landed);
        }
        out
    }

    /// Is `key` still running (dispatched in this or an earlier round)?
    pub fn in_flight(&self, key: &str) -> bool {
        self.in_flight.contains(key)
    }

    pub fn in_flight_keys(&self) -> &HashSet<String> {
        &self.in_flight
    }

    /// Run `work` for `key` in its own task this round. Returns false, and
    /// spawns nothing, while `key` is still in flight.
    pub fn spawn<F>(&mut self, key: &str, work: F) -> bool
    where
        F: Future<Output = T> + Send + 'static,
    {
        if !self.in_flight.insert(key.to_string()) {
            return false;
        }
        self.dispatched.insert(key.to_string());
        let done = Completion::new(self.tx.clone(), self.round, key.to_string());
        tokio::spawn(async move { done.finish(work.await) });
        true
    }

    /// Wait until every target dispatched THIS round has reported, or until
    /// `deadline`. Returns everything that landed meanwhile (stragglers of
    /// earlier rounds included) and how many of this round's targets are
    /// still in flight. It never waits on an earlier round's straggler: a
    /// target that is slow every time would otherwise hold every round to the
    /// full deadline.
    pub async fn collect(&mut self, deadline: tokio::time::Instant) -> (Vec<Landed<T>>, usize) {
        let mut out = Vec::new();
        while !self.dispatched.is_empty() {
            match tokio::time::timeout_at(deadline, self.rx.recv()).await {
                Ok(Some(landed)) => {
                    self.in_flight.remove(&landed.1);
                    if landed.0 == self.round {
                        self.dispatched.remove(&landed.1);
                    }
                    out.push(landed);
                }
                Ok(None) | Err(_) => break,
            }
        }
        (out, self.dispatched.len())
    }
}
