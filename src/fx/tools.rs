use serde_json::Value;
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct ToolDescription {
    pub title: String,
    pub argument: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity: Option<&'static str>,
}
pub const ACTIVITY_ORDER: [&str; 17] = [
    "commands",
    "wrote_files",
    "edited_files",
    "read_files",
    "searched_files",
    "searched_code",
    "searched_web",
    "searched_capabilities",
    "fetched_pages",
    "used_skills",
    "installed_skills",
    "used_subagents",
    "inspected_images",
    "read_tool_results",
    "asked_user",
    "used_chat_tools",
    "used_external_tools",
];
pub fn reads_telegram_guidelines(input: &Value) -> bool {
    input["uri"] == "telegram://guidelines"
}
fn text(v: &Value) -> String {
    let s = if let Some(s) = v.as_str() {
        s.to_string()
    } else if v.is_null() || v.as_object().is_some_and(|o| o.is_empty()) {
        String::new()
    } else {
        v.to_string()
    };
    truncate(&crate::secrets::redact(&s), 800)
}
pub fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_owned()
    } else {
        format!(
            "{}…",
            s.chars().take(n.saturating_sub(1)).collect::<String>()
        )
    }
}
pub fn argument_preview(s: &str) -> String {
    truncate(&s.split_whitespace().collect::<Vec<_>>().join(" "), 60)
}
pub fn describe_tool(name: &str, title: &str, kind: &str, input: &Value) -> ToolDescription {
    let empty = serde_json::json!({});
    let input = if input.is_object() { input } else { &empty };
    let request = if input["request"].is_object() {
        &input["request"]
    } else {
        input
    };
    let (title, arg, activity) = match name.trim() {
        "read_file" => ("Reading file", &input["path"], Some("read_files")),
        "glob_files" => ("Finding files", &input["pattern"], Some("searched_files")),
        "grep_files" => ("Searching code", &input["pattern"], Some("searched_code")),
        "edit_file" => ("Editing file", &input["path"], Some("edited_files")),
        "write_file" => ("Writing file", &input["path"], Some("wrote_files")),
        "shell" => match request["action"].as_str() {
            Some("run") => ("Running command", &request["command"], Some("commands")),
            Some("interact") if request["chars"].as_str().is_some_and(|s| !s.is_empty()) => {
                ("Sending input", &request["chars"], None)
            }
            Some("interact") => ("Waiting for command", &Value::Null, None),
            Some("stop") => ("Stopping command", &Value::Null, None),
            _ => ("Managing shell", &Value::Null, None),
        },
        "subagent" => (
            "Running subagent",
            if request["task"].is_null() {
                &request["message"]
            } else {
                &request["task"]
            },
            Some("used_subagents"),
        ),
        "capability_search" => (
            "Finding tools and skills",
            &input["query"],
            Some("searched_capabilities"),
        ),
        "skill" => ("Loading skill", &input["name"], Some("used_skills")),
        "install_skill" => (
            "Installing skill",
            &input["source"],
            Some("installed_skills"),
        ),
        "mcp_select_tool" => ("Selecting MCP tool", &input["name"], None),
        "mcp_features" => {
            if reads_telegram_guidelines(input) {
                ("Reading guidelines", &Value::Null, Some("used_chat_tools"))
            } else {
                (
                    "Using MCP resource or prompt",
                    if !input["uri"].is_null() {
                        &input["uri"]
                    } else if !input["prompt"].is_null() {
                        &input["prompt"]
                    } else {
                        &input["server"]
                    },
                    Some("used_external_tools"),
                )
            }
        }
        "ask_user_question" => ("Asking a question", &Value::Null, Some("asked_user")),
        "web_fetch" => ("Fetching web page", &input["url"], Some("fetched_pages")),
        "web_search" => ("Searching web", &input["query"], Some("searched_web")),
        "vision" => (
            "Inspecting images",
            &input["paths"],
            Some("inspected_images"),
        ),
        "read_tool_result" => (
            "Reading tool result",
            &request["query"],
            Some("read_tool_results"),
        ),
        name if name.starts_with("mcp_telegram_") => {
            let tool = &name[13..];
            let title = match tool {
                "read_history" => "Reading conversation",
                "set_reaction" => "Reacting to message",
                "download_attachment" => "Downloading attachment",
                "send_file" => "Sending file",
                "send_photo" => "Sending photo",
                "send_voice" => "Sending voice message",
                "send_video_note" => "Sending circular video",
                "get_sticker_pack" => "Loading sticker pack",
                "send_sticker_by_id" | "send_sticker_file" => "Sending sticker",
                "request_choice" => "Asking for a choice",
                "create_poll" => "Creating poll",
                "set_pinned_message" => "Setting pinned message",
                "pin_message" => "Pinning message",
                "unpin_message" => "Unpinning message",
                "manage_topic" => "Managing topic",
                "delete_messages" => "Deleting messages",
                "moderate_member" => "Moderating member",
                "review_join_request" => "Reviewing join request",
                _ => "Using MCP tool",
            };
            return ToolDescription {
                title: title.into(),
                argument: if title == "Using MCP tool" {
                    name[4..].into()
                } else {
                    String::new()
                },
                activity: Some(if title == "Using MCP tool" {
                    "used_external_tools"
                } else {
                    "used_chat_tools"
                }),
            };
        }
        name if name.starts_with("mcp_") => {
            return ToolDescription {
                title: "Using MCP tool".into(),
                argument: text(&Value::String(name[4..].into())),
                activity: Some("used_external_tools"),
            };
        }
        _ => (
            if title.trim().is_empty() {
                "Tool"
            } else {
                title.trim()
            },
            input,
            match kind {
                "read" => Some("read_files"),
                "edit" | "delete" | "move" => Some("edited_files"),
                "search" => Some("searched_code"),
                "execute" => Some("commands"),
                "fetch" => Some("fetched_pages"),
                _ => None,
            },
        ),
    };
    ToolDescription {
        title: crate::secrets::redact(title),
        argument: text(arg),
        activity,
    }
}
pub fn progress_phrase(activity: Option<&str>) -> &'static str {
    match activity {
        Some("commands") => "Running commands…",
        Some("wrote_files" | "edited_files") => "Editing files…",
        Some("read_files") => "Reading files…",
        Some("searched_files" | "searched_code") => "Searching code…",
        Some("searched_web" | "fetched_pages") => "Browsing the web…",
        Some("searched_capabilities" | "used_skills" | "installed_skills") => "Loading skills…",
        Some("used_subagents") => "Running subagents…",
        Some("inspected_images") => "Looking at images…",
        Some("read_tool_results") => "Reading results…",
        Some("asked_user") => "Asking a question…",
        Some("used_chat_tools") => "Using Telegram…",
        Some("used_external_tools") => "Using tools…",
        _ => "Working…",
    }
}
pub fn activity_summary(activity: &str, count: usize) -> String {
    let counted =
        |singular: &str| format!("{count} {singular}{}", if count == 1 { "" } else { "s" });
    match activity {
        "commands" => format!("ran {}", counted("command")),
        "wrote_files" => format!("wrote {}", counted("file")),
        "edited_files" => format!("edited {}", counted("file")),
        "read_files" => format!("read {}", counted("file")),
        "searched_files" => "searched files".into(),
        "searched_code" => "searched code".into(),
        "searched_web" => "searched web".into(),
        "searched_capabilities" => "searched capabilities".into(),
        "fetched_pages" => format!("fetched {}", counted("page")),
        "used_skills" => "used skills".into(),
        "installed_skills" => format!("installed {}", counted("skill")),
        "used_subagents" => "used subagents".into(),
        "inspected_images" => "inspected images".into(),
        "read_tool_results" => format!("read {}", counted("tool result")),
        "asked_user" => "asked user".into(),
        "used_chat_tools" => "used chat tools".into(),
        _ => "used external tools".into(),
    }
}

pub const FX_TOOL_NAMES: [&str; 17] = [
    "read_file",
    "glob_files",
    "grep_files",
    "edit_file",
    "write_file",
    "shell",
    "subagent",
    "capability_search",
    "skill",
    "install_skill",
    "mcp_select_tool",
    "mcp_features",
    "ask_user_question",
    "web_fetch",
    "web_search",
    "vision",
    "read_tool_result",
];
