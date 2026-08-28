//! Tests for the SSE parser.

use pi_inference::streaming::{SseParser, StreamEvent};

#[test]
fn parse_text_delta() {
    let mut parser = SseParser::new();
    let input = "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n";
    let events = parser.feed(input);

    assert_eq!(events.len(), 1);
    match &events[0] {
        StreamEvent::TextDelta(t) => assert_eq!(t, "Hello"),
        other => panic!("Expected TextDelta, got {:?}", other),
    }
}

#[test]
fn parse_multiple_deltas() {
    let mut parser = SseParser::new();
    let input = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n",
        "\n"
    );
    let events = parser.feed(input);

    assert_eq!(events.len(), 2);
    match (&events[0], &events[1]) {
        (StreamEvent::TextDelta(a), StreamEvent::TextDelta(b)) => {
            assert_eq!(a, "Hello");
            assert_eq!(b, " world");
        }
        other => panic!("Expected two TextDeltas, got {:?}", other),
    }
}

#[test]
fn parse_done_signal() {
    let mut parser = SseParser::new();
    let input = "data: [DONE]\n\n";
    let events = parser.feed(input);

    assert_eq!(events.len(), 1);
    assert!(matches!(events[0], StreamEvent::Done));
}

#[test]
fn parse_thinking_delta() {
    let mut parser = SseParser::new();
    let input = "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"Let me think...\"}}]}\n\n";
    let events = parser.feed(input);

    assert_eq!(events.len(), 1);
    match &events[0] {
        StreamEvent::ThinkingDelta(t) => assert_eq!(t, "Let me think..."),
        other => panic!("Expected ThinkingDelta, got {:?}", other),
    }
}

#[test]
fn parse_tool_call_delta() {
    let mut parser = SseParser::new();
    let input = concat!(
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_123\",\"function\":{\"name\":\"get_weather\",\"arguments\":\"\"}}]}}]}\n",
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"city\\\"\"}}]}}]}\n",
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\": \\\"London\\\"}\"}}]}}]}\n",
        "\n"
    );
    let events = parser.feed(input);

    assert_eq!(events.len(), 3);

    match &events[0] {
        StreamEvent::ToolCallDelta {
            index,
            id,
            name,
            arguments_delta,
        } => {
            assert_eq!(*index, 0);
            assert_eq!(id.as_deref(), Some("call_123"));
            assert_eq!(name.as_deref(), Some("get_weather"));
            assert_eq!(arguments_delta, "");
        }
        other => panic!("Expected ToolCallDelta, got {:?}", other),
    }
}

#[test]
fn parse_usage() {
    let mut parser = SseParser::new();
    let input =
        "data: {\"usage\":{\"prompt_tokens\":42,\"completion_tokens\":10}}\n\n";
    let events = parser.feed(input);

    assert_eq!(events.len(), 1);
    match &events[0] {
        StreamEvent::Usage(u) => {
            assert_eq!(u.prompt_tokens, 42);
            assert_eq!(u.completion_tokens, 10);
        }
        other => panic!("Expected Usage, got {:?}", other),
    }
}

#[test]
fn parse_invalid_json_returns_error() {
    let mut parser = SseParser::new();
    let input = "data: {not valid json}\n\n";
    let events = parser.feed(input);

    assert_eq!(events.len(), 1);
    assert!(matches!(events[0], StreamEvent::Error(_)));
}

#[test]
fn parse_empty_content_skipped() {
    let mut parser = SseParser::new();
    let input = "data: {\"choices\":[{\"delta\":{\"content\":\"\"}}]}\n\n";
    let events = parser.feed(input);
    // Empty content produces None, so no events
    assert_eq!(events.len(), 0);
}

#[test]
fn parse_finish_reason_without_delta_skipped() {
    let mut parser = SseParser::new();
    let input = "data: {\"choices\":[{\"finish_reason\":\"stop\"}]}\n\n";
    let events = parser.feed(input);
    // finish_reason without delta is just a signal, no event
    assert_eq!(events.len(), 0);
}

#[test]
fn incremental_feed() {
    let mut parser = SseParser::new();

    // Feed partial data
    let events1 = parser.feed("data: {\"choices\":[{\"del");
    assert_eq!(events1.len(), 0, "partial line should not produce events");

    // Complete the line
    let events2 = parser.feed("ta\":{\"content\":\"Hi\"}}]}\n\n");
    assert_eq!(events2.len(), 1);
    match &events2[0] {
        StreamEvent::TextDelta(t) => assert_eq!(t, "Hi"),
        other => panic!("Expected TextDelta, got {:?}", other),
    }
}

#[test]
fn ignore_non_data_lines() {
    let mut parser = SseParser::new();
    let input = concat!(
        "event: message\n",
        ": this is a comment\n",
        "id: 123\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n",
        "\n"
    );
    let events = parser.feed(input);
    assert_eq!(events.len(), 1);
    match &events[0] {
        StreamEvent::TextDelta(t) => assert_eq!(t, "ok"),
        other => panic!("Expected TextDelta, got {:?}", other),
    }
}

#[test]
fn handles_carriage_return_line_endings() {
    let mut parser = SseParser::new();
    let input = "data: {\"choices\":[{\"delta\":{\"content\":\"cr\"}}]}\r\n\r\n";
    let events = parser.feed(input);
    assert_eq!(events.len(), 1);
    match &events[0] {
        StreamEvent::TextDelta(t) => assert_eq!(t, "cr"),
        other => panic!("Expected TextDelta, got {:?}", other),
    }
}
