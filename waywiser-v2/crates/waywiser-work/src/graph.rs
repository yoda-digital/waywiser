//! Dependency graph with topological sort and cycle detection.

use pi_types::WorkItemId;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;

/// Error indicating a dependency cycle was detected.
#[derive(Debug, Clone)]
pub struct CycleError {
    pub cycle: Vec<WorkItemId>,
}

impl fmt::Display for CycleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "dependency cycle detected: {:?}", self.cycle)
    }
}

impl std::error::Error for CycleError {}

/// A directed acyclic graph of work item dependencies.
///
/// Each item maps to a list of items it depends on (must complete before it).
#[derive(Debug, Clone, Default)]
pub struct DependencyGraph {
    /// item → items it depends on
    deps: HashMap<WorkItemId, Vec<WorkItemId>>,
    /// item → items that depend on it (reverse edges)
    dependents: HashMap<WorkItemId, Vec<WorkItemId>>,
}

impl DependencyGraph {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add an item with its dependencies. Does not check for cycles (use `detect_cycle` after).
    pub fn add_item(&mut self, id: WorkItemId, deps: Vec<WorkItemId>) {
        for dep in &deps {
            self.dependents
                .entry(*dep)
                .or_default()
                .push(id);
        }
        self.deps.insert(id, deps);
        // Ensure the item exists in dependents map even if nothing depends on it
        self.dependents.entry(id).or_default();
    }

    /// Remove an item and all edges involving it.
    pub fn remove_item(&mut self, id: &WorkItemId) {
        // Remove forward edges
        if let Some(deps) = self.deps.remove(id) {
            for dep in &deps {
                if let Some(rev) = self.dependents.get_mut(dep) {
                    rev.retain(|d| d != id);
                }
            }
        }
        // Remove reverse edges
        self.dependents.remove(id);
        // Remove this item from any other item's deps
        for deps_list in self.deps.values_mut() {
            deps_list.retain(|d| d != id);
        }
    }

    /// Kahn's algorithm for topological sort.
    /// Returns items in dependency order (dependencies first).
    pub fn topological_sort(&self) -> Result<Vec<WorkItemId>, CycleError> {
        let mut in_degree: HashMap<WorkItemId, usize> = HashMap::new();

        // Initialize in-degree for all known nodes
        for id in self.deps.keys() {
            in_degree.entry(*id).or_insert(0);
        }
        for id in self.dependents.keys() {
            in_degree.entry(*id).or_insert(0);
        }

        // Calculate in-degrees from deps
        for (id, deps) in &self.deps {
            // Each dependency adds an edge dep → id, so id's in-degree is len(deps)
            // But only count deps that are actually in the graph
            let count = deps.iter().filter(|d| self.deps.contains_key(d) || self.dependents.contains_key(d)).count();
            *in_degree.entry(*id).or_insert(0) = count;
        }

        let mut queue: VecDeque<WorkItemId> = in_degree
            .iter()
            .filter(|(_, deg)| **deg == 0)
            .map(|(id, _)| *id)
            .collect();

        let mut result = Vec::new();

        while let Some(node) = queue.pop_front() {
            result.push(node);
            if let Some(dependents) = self.dependents.get(&node) {
                for dep in dependents {
                    if let Some(deg) = in_degree.get_mut(dep) {
                        *deg = deg.saturating_sub(1);
                        if *deg == 0 {
                            queue.push_back(*dep);
                        }
                    }
                }
            }
        }

        if result.len() < in_degree.len() {
            // There's a cycle — find it with DFS
            if let Some(cycle) = self.find_cycle(&in_degree, &result) {
                return Err(CycleError { cycle });
            }
            // Fallback: report remaining nodes
            let sorted_set: HashSet<_> = result.iter().collect();
            let remaining: Vec<_> = in_degree
                .keys()
                .filter(|k| !sorted_set.contains(k))
                .copied()
                .collect();
            return Err(CycleError { cycle: remaining });
        }

        Ok(result)
    }

    /// Detect a cycle in the graph. Returns the cycle path if found.
    pub fn detect_cycle(&self) -> Option<Vec<WorkItemId>> {
        match self.topological_sort() {
            Ok(_) => None,
            Err(e) => Some(e.cycle),
        }
    }

    /// Check if all dependencies of the given item are in the completed set.
    pub fn dependencies_met(&self, id: &WorkItemId, completed: &HashSet<WorkItemId>) -> bool {
        match self.deps.get(id) {
            None => true,
            Some(deps) => deps.iter().all(|d| completed.contains(d)),
        }
    }

    /// Get the dependencies of a given item.
    pub fn get_dependencies(&self, id: &WorkItemId) -> &[WorkItemId] {
        self.deps.get(id).map(|v| v.as_slice()).unwrap_or(&[])
    }

    /// Get items that depend on the given item.
    pub fn get_dependents(&self, id: &WorkItemId) -> &[WorkItemId] {
        self.dependents.get(id).map(|v| v.as_slice()).unwrap_or(&[])
    }

    /// Number of items in the graph.
    pub fn len(&self) -> usize {
        let mut all: HashSet<WorkItemId> = self.deps.keys().copied().collect();
        all.extend(self.dependents.keys());
        all.len()
    }

    pub fn is_empty(&self) -> bool {
        self.deps.is_empty() && self.dependents.is_empty()
    }

    /// DFS helper to find a cycle among nodes not in the sorted result.
    fn find_cycle(
        &self,
        in_degree: &HashMap<WorkItemId, usize>,
        sorted: &[WorkItemId],
    ) -> Option<Vec<WorkItemId>> {
        let sorted_set: HashSet<_> = sorted.iter().copied().collect();
        let unsorted: Vec<_> = in_degree
            .keys()
            .filter(|k| !sorted_set.contains(k))
            .copied()
            .collect();

        if unsorted.is_empty() {
            return None;
        }

        let mut visited = HashSet::new();
        let mut in_stack = HashSet::new();
        let mut path = Vec::new();

        for &start in &unsorted {
            if !visited.contains(&start) {
                if self.dfs_cycle(start, &mut visited, &mut in_stack, &mut path) {
                    return Some(path);
                }
            }
        }

        // If DFS didn't find a clean cycle, return all unsorted nodes
        Some(unsorted)
    }

    fn dfs_cycle(
        &self,
        node: WorkItemId,
        visited: &mut HashSet<WorkItemId>,
        in_stack: &mut HashSet<WorkItemId>,
        path: &mut Vec<WorkItemId>,
    ) -> bool {
        visited.insert(node);
        in_stack.insert(node);
        path.push(node);

        if let Some(deps) = self.deps.get(&node) {
            for &dep in deps {
                if !visited.contains(&dep) {
                    if self.dfs_cycle(dep, visited, in_stack, path) {
                        return true;
                    }
                } else if in_stack.contains(&dep) {
                    path.push(dep);
                    return true;
                }
            }
        }

        in_stack.remove(&node);
        path.pop();
        false
    }
}
