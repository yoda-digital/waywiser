use chrono::Utc;
use pi_types::WorkItemId;
use uuid::Uuid;
use waywiser_work::{
    ApprovalState, BlockReason, KanbanProjection, Priority, WorkItem, WorkStatus,
};

fn make_item(status: WorkStatus) -> WorkItem {
    let now = Utc::now();
    WorkItem {
        id: WorkItemId(Uuid::now_v7()),
        goal_id: None,
        title: "test".to_string(),
        description: "test item".to_string(),
        status,
        priority: Priority::Medium,
        dependencies: vec![],
        assignee: None,
        agent_session_id: None,
        attempts: 0,
        due_at: None,
        evidence: vec![],
        result: None,
        approval_state: ApprovalState::NotRequired,
        created_at: now,
        updated_at: now,
    }
}

#[test]
fn maps_statuses_to_columns() {
    let items = vec![
        make_item(WorkStatus::Proposed),
        make_item(WorkStatus::Proposed),
        make_item(WorkStatus::Ready),
        make_item(WorkStatus::Running),
        make_item(WorkStatus::Review),
        make_item(WorkStatus::Done),
        make_item(WorkStatus::Done),
        make_item(WorkStatus::Done),
        make_item(WorkStatus::Blocked(BlockReason {
            reason: "waiting".to_string(),
            blocked_by: None,
        })),
    ];

    let kanban = KanbanProjection::from_work_items(&items);

    assert_eq!(kanban.column("Backlog").unwrap().items.len(), 2);
    assert_eq!(kanban.column("Ready").unwrap().items.len(), 1);
    assert_eq!(kanban.column("In Progress").unwrap().items.len(), 1);
    assert_eq!(kanban.column("Review").unwrap().items.len(), 1);
    assert_eq!(kanban.column("Done").unwrap().items.len(), 3);
    assert_eq!(kanban.column("Blocked").unwrap().items.len(), 1);
}

#[test]
fn total_items_correct() {
    let items = vec![
        make_item(WorkStatus::Proposed),
        make_item(WorkStatus::Running),
        make_item(WorkStatus::Done),
    ];
    let kanban = KanbanProjection::from_work_items(&items);
    assert_eq!(kanban.total_items(), 3);
}

#[test]
fn empty_items_gives_empty_columns() {
    let kanban = KanbanProjection::from_work_items(&[]);
    assert_eq!(kanban.total_items(), 0);
    assert_eq!(kanban.columns.len(), 6); // all 6 columns still exist
}

#[test]
fn in_progress_has_wip_limit() {
    let kanban = KanbanProjection::from_work_items(&[]);
    let in_progress = kanban.column("In Progress").unwrap();
    assert_eq!(in_progress.wip_limit, Some(5));
}

#[test]
fn column_names_are_correct() {
    let kanban = KanbanProjection::from_work_items(&[]);
    let names: Vec<&str> = kanban.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(
        names,
        vec!["Backlog", "Ready", "In Progress", "Review", "Done", "Blocked"]
    );
}
