//! Incidents — the operational record the platform owner manages from the ops
//! dashboard (status-page style: severity, lifecycle, timeline of updates).

use hive_core::now_ms;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Minor,
    Major,
    Critical,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IncidentStatus {
    Investigating,
    Identified,
    Monitoring,
    Resolved,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct IncidentUpdate {
    pub ts_ms: u64,
    pub status: IncidentStatus,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Incident {
    pub id: String,
    pub title: String,
    pub severity: Severity,
    pub status: IncidentStatus,
    #[serde(default)]
    pub affected: Vec<String>, // regions / components
    pub created_ms: u64,
    pub updated_ms: u64,
    #[serde(default)]
    pub updates: Vec<IncidentUpdate>,
}

#[derive(Serialize, Deserialize)]
pub struct OpenReq {
    pub title: String,
    pub severity: Severity,
    #[serde(default)]
    pub affected: Vec<String>,
    #[serde(default)]
    pub message: String,
}

#[derive(Serialize, Deserialize)]
pub struct UpdateReq {
    pub status: IncidentStatus,
    pub message: String,
}

pub struct IncidentStore {
    items: RwLock<Vec<Incident>>,
}

impl IncidentStore {
    pub fn new() -> IncidentStore {
        IncidentStore {
            items: RwLock::new(Vec::new()),
        }
    }

    pub fn list(&self) -> Vec<Incident> {
        let mut v = self.items.read().clone();
        v.sort_by(|a, b| b.created_ms.cmp(&a.created_ms));
        v
    }

    pub fn open_count(&self) -> usize {
        self.items
            .read()
            .iter()
            .filter(|i| i.status != IncidentStatus::Resolved)
            .count()
    }

    pub fn snapshot(&self) -> Vec<Incident> {
        self.items.read().clone()
    }

    pub fn load(&self, data: Vec<Incident>) {
        *self.items.write() = data;
    }

    /// Open `req` — or, when an UNRESOLVED incident with the same title and the
    /// same `affected` set already exists, touch that one (`updated_ms` only:
    /// no timeline entry, so a condition re-asserted every tick cannot grow it
    /// without bound) and return it. Lookup and insert happen under ONE write
    /// lock, so two concurrent openers of the same condition get one incident.
    ///
    /// Deduplication is the DEFAULT because every automated opener fires on a
    /// cadence or on an edge that can recur: the node-death self-heal alone
    /// opened 3.4k–12.5k duplicate "Redeploying … its host node went offline"
    /// incidents per node in a day, and the DNS "delegation held" pair re-armed
    /// on every leadership edge. Only an operator's explicit POST opens a new
    /// record unconditionally ([`Self::open_new`]).
    pub fn open(&self, req: OpenReq) -> Incident {
        let mut items = self.items.write();
        let mut wanted = req.affected.clone();
        wanted.sort();
        if let Some(inc) = items.iter_mut().find(|i| {
            i.status != IncidentStatus::Resolved && i.title == req.title && {
                let mut have = i.affected.clone();
                have.sort();
                have == wanted
            }
        }) {
            inc.updated_ms = now_ms();
            return inc.clone();
        }
        let inc = Self::build(req);
        items.push(inc.clone());
        inc
    }

    /// Always open a NEW incident — the operator's `POST /v1/incidents`. Never
    /// for an automated opener (use [`Self::open`]).
    pub fn open_new(&self, req: OpenReq) -> Incident {
        let inc = Self::build(req);
        self.items.write().push(inc.clone());
        inc
    }

    fn build(req: OpenReq) -> Incident {
        let now = now_ms();
        Incident {
            id: format!("inc_{}", uuid::Uuid::new_v4().simple()),
            title: req.title,
            severity: req.severity,
            status: IncidentStatus::Investigating,
            affected: req.affected,
            created_ms: now,
            updated_ms: now,
            updates: vec![IncidentUpdate {
                ts_ms: now,
                status: IncidentStatus::Investigating,
                message: if req.message.is_empty() {
                    "Incident opened.".into()
                } else {
                    req.message
                },
            }],
        }
    }

    pub fn update(&self, id: &str, req: UpdateReq) -> Option<Incident> {
        let now = now_ms();
        let mut items = self.items.write();
        let inc = items.iter_mut().find(|i| i.id == id)?;
        inc.status = req.status;
        inc.updated_ms = now;
        inc.updates.push(IncidentUpdate {
            ts_ms: now,
            status: req.status,
            message: req.message,
        });
        Some(inc.clone())
    }

    /// Remove an incident entirely (vs. `update` which only transitions its
    /// status). Returns the removed incident if it existed. The fleet follower
    /// sync adopts the leader's post-delete snapshot wholesale, so a delete on
    /// the leader propagates to every node's list on the next tick.
    pub fn remove(&self, id: &str) -> Option<Incident> {
        let mut items = self.items.write();
        let pos = items.iter().position(|i| i.id == id)?;
        Some(items.remove(pos))
    }
}

impl Default for IncidentStore {
    fn default() -> Self {
        Self::new()
    }
}
