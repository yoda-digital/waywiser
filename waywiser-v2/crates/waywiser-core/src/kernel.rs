//! WaywiserKernel — central service registry (§9).

use crate::brain::BrainService;
use crate::identity::IdentityService;
use crate::memory::MemoryStore;
use crate::permissions::PermissionService;
use crate::skills::SkillService;

/// Central kernel holding all Waywiser domain services.
///
/// Not an extension chain — a service graph where each service
/// communicates through defined interfaces.
pub struct WaywiserKernel {
    pub identity: IdentityService,
    pub memory: Box<dyn MemoryStore>,
    pub brain: BrainService,
    pub permission: PermissionService,
    pub skills: SkillService,
}

impl WaywiserKernel {
    /// Create a new kernel with the given services.
    pub fn new(
        identity: IdentityService,
        memory: Box<dyn MemoryStore>,
        brain: BrainService,
        permission: PermissionService,
        skills: SkillService,
    ) -> Self {
        Self {
            identity,
            memory,
            brain,
            permission,
            skills,
        }
    }
}
