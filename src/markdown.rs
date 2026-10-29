use anyhow::Result;
use comrak::{
    Arena, Options,
    nodes::{AstNode, ListType, NodeValue},
    parse_document,
};
use frankenstein::rich_message::InputRichMessage;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub fn options() -> Options<'static> {
    let mut o = Options::default();
    o.extension.table = true;
    o.extension.tasklist = true;
    o.extension.strikethrough = true;
    o.extension.autolink = true;
    o.extension.math_dollars = true;
    o.extension.math_code = true;
    o.extension.spoiler = true;
    o.extension.highlight = true;
    o
}
fn rich<'a>(node: &'a AstNode<'a>) -> Value {
    fn append(parts: &mut Vec<Value>, part: Value) {
        match part {
            Value::Array(items) => {
                for item in items {
                    append(parts, item);
                }
            }
            Value::String(s) if s.is_empty() => {}
            Value::String(s) => {
                if let Some(Value::String(last)) = parts.last_mut() {
                    last.push_str(&s);
                } else {
                    parts.push(Value::String(s));
                }
            }
            other => parts.push(other),
        }
    }
    let mut parts = Vec::new();
    for part in node.children().filter_map(inline) {
        append(&mut parts, part);
    }
    if parts.is_empty() {
        json!("")
    } else if parts.len() == 1 {
        parts[0].clone()
    } else {
        Value::Array(parts)
    }
}
fn inline<'a>(node: &'a AstNode<'a>) -> Option<Value> {
    let d = node.data();
    Some(match &d.value {
        NodeValue::Text(s) => json!(s),
        NodeValue::Code(c) => json!({"type":"code","text":c.literal}),
        NodeValue::SoftBreak | NodeValue::LineBreak => json!("\n"),
        NodeValue::Strong => json!({"type":"bold","text":rich(node)}),
        NodeValue::Emph => json!({"type":"italic","text":rich(node)}),
        NodeValue::Strikethrough => json!({"type":"strikethrough","text":rich(node)}),
        NodeValue::SpoileredText => json!({"type":"spoiler","text":rich(node)}),
        NodeValue::Highlight => json!({"type":"marked","text":rich(node)}),
        NodeValue::Math(m) => json!({"type":"mathematical_expression","expression":m.literal}),
        NodeValue::Link(l) | NodeValue::Image(l) => {
            if ["https:", "http:", "tg:", "mailto:", "tel:"]
                .iter()
                .any(|p| l.url.to_ascii_lowercase().starts_with(p))
            {
                json!({"type":"url","text":rich(node),"url":l.url})
            } else {
                rich(node)
            }
        }
        NodeValue::HtmlInline(_) => return None,
        _ => rich(node),
    })
}
fn excerpt<'s>(node: &AstNode<'_>, source: &'s str) -> &'s str {
    let pos = node.data().sourcepos;
    let lines: Vec<_> = source.split_inclusive('\n').collect();
    let start = lines
        .iter()
        .take(pos.start.line.saturating_sub(1))
        .map(|l| l.len())
        .sum::<usize>()
        + pos.start.column.saturating_sub(1);
    let end = lines
        .iter()
        .take(pos.end.line.saturating_sub(1))
        .map(|l| l.len())
        .sum::<usize>()
        + pos.end.column;
    source
        .get(start.min(source.len())..end.min(source.len()).max(start.min(source.len())))
        .unwrap_or("")
}
fn blocks<'a>(node: &'a AstNode<'a>, source: &str) -> Vec<Value> {
    node.children().flat_map(|n| block(n, source)).collect()
}
fn block<'a>(node: &'a AstNode<'a>, source: &str) -> Vec<Value> {
    let d = node.data();
    let raw = excerpt(node, source).trim_end();
    let literal = || json!({"type":"paragraph","text":raw});
    let b = match &d.value {
        NodeValue::Paragraph => {
            if let Some(first) = node.first_child()
                && first.next_sibling().is_none()
                && let NodeValue::Math(m) = &first.data().value
                && m.display_math
            {
                return vec![
                    json!({"type":"mathematical_expression","expression":m.literal.trim_matches('\n')}),
                ];
            }
            // Marked treats an opened display-math block as math while streaming.
            if let Some(body) = raw.trim_start().strip_prefix("$$")
                && !body.starts_with('$')
                && !body.contains("$$")
                && !body.trim().is_empty()
            {
                return vec![
                    json!({"type":"mathematical_expression","expression":body.trim_start_matches([' ', '\t', '\n']).trim_end_matches('\n')}),
                ];
            }
            json!({"type":"paragraph","text":rich(node)})
        }
        NodeValue::Heading(h) => {
            let text = rich(node);
            if text == "" {
                literal()
            } else {
                json!({"type":"heading","size":h.level,"text":text})
            }
        }
        NodeValue::CodeBlock(c) => {
            if c.literal.trim_end().is_empty() {
                literal()
            } else if c.info.trim().eq_ignore_ascii_case("math") {
                json!({"type":"mathematical_expression","expression":c.literal.trim_end()})
            } else {
                let mut v = json!({"type":"pre","text":c.literal.trim_end()});
                if let Some(lang) = c.info.split_whitespace().next() {
                    v["language"] = json!(lang);
                }
                v
            }
        }
        NodeValue::BlockQuote => {
            let nested = blocks(node, source);
            if nested.is_empty() {
                literal()
            } else {
                json!({"type":"blockquote","blocks":nested})
            }
        }
        NodeValue::List(l) => {
            let items: Vec<_> = node
                .children()
                .enumerate()
                .map(|(i, n)| {
                    let mut item = json!({"blocks":blocks(n, source)});
                    if let NodeValue::TaskItem(t) = &n.data().value {
                        item["has_checkbox"] = json!(true);
                        item["is_checked"] = json!(t.symbol.is_some());
                    }
                    if l.list_type == ListType::Ordered {
                        item["type"] = json!("1");
                        let marker = excerpt(n, source)
                            .trim_start()
                            .chars()
                            .take_while(char::is_ascii_digit)
                            .collect::<String>();
                        item["value"] = json!(marker.parse::<usize>().unwrap_or(l.start + i));
                    }
                    item
                })
                .collect();
            if items
                .iter()
                .any(|v| v["blocks"].as_array().is_some_and(Vec::is_empty))
            {
                literal()
            } else {
                json!({"type":"list","items":items})
            }
        }
        NodeValue::Table(table) => {
            let cells:Vec<Vec<_>>=node.children().map(|row|{
                let header=matches!(row.data().value,NodeValue::TableRow(true));
                row.children().enumerate().map(|(i,c)|json!({"text":rich(c),"is_header":header,"align":format!("{:?}",table.alignments[i]).to_lowercase().replace("none","left"),"valign":"top"})).collect()
            }).collect();
            if table.num_columns > 20 {
                json!({"type":"pre","text":raw})
            } else {
                json!({"type":"table","cells":cells})
            }
        }
        NodeValue::HtmlBlock(_) | NodeValue::ThematicBreak => return vec![],
        _ => return blocks(node, source),
    };
    vec![b]
}
pub fn render(source: &str) -> Result<InputRichMessage> {
    let arena = Arena::new();
    let root = parse_document(&arena, source, &options());
    let mut spaced: Vec<Value> = Vec::new();
    for block in blocks(root, source) {
        if spaced
            .last()
            .is_some_and(|p| p["type"] == "paragraph" && p["text"] != "\u{a0}")
            && block["type"] == "paragraph"
            && block["text"] != "\u{a0}"
        {
            spaced.push(json!({"type":"paragraph","text":"\u{a0}"}));
        }
        spaced.push(block);
    }
    Ok(serde_json::from_value(json!({"blocks":spaced}))?)
}
/// UTF-16 offsets are Telegram's wire format, not Rust byte indices.
pub fn utf16_slice(text: &str, offset: usize, length: usize) -> Option<String> {
    let units: Vec<_> = text.encode_utf16().collect();
    String::from_utf16(units.get(offset..offset.checked_add(length)?)?).ok()
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Section {
    pub heading: Option<String>,
    pub text: String,
    pub hash: Vec<u8>,
}
pub fn sections(source: &str) -> Vec<Section> {
    let arena = Arena::new();
    let root = parse_document(&arena, source, &options());
    let mut starts = vec![(0, None)];
    let mut lines = vec![0];
    for (i, b) in source.bytes().enumerate() {
        if b == b'\n' {
            lines.push(i + 1);
        }
    }
    for n in root.children() {
        if let NodeValue::Heading(h) = &n.data().value
            && h.level == 1
        {
            let at = lines[n.data().sourcepos.start.line - 1];
            let name = n
                .descendants()
                .filter_map(|c| {
                    if let NodeValue::Text(t) = &c.data().value {
                        Some(t.to_string())
                    } else {
                        None
                    }
                })
                .collect::<String>();
            if at == 0 {
                starts.clear();
            }
            starts.push((at, Some(name)));
        }
    }
    starts
        .iter()
        .enumerate()
        .filter_map(|(i, (at, name))| {
            let end = starts.get(i + 1).map(|x| x.0).unwrap_or(source.len());
            let text = source[*at..end].trim_end();
            if text.trim().is_empty() {
                None
            } else {
                Some(Section {
                    heading: name.clone(),
                    text: text.into(),
                    hash: Sha256::digest(text).to_vec(),
                })
            }
        })
        .collect()
}
#[derive(Debug, PartialEq, Eq)]
pub enum MemoryChange {
    Initial,
    Append(Vec<String>),
    Reread,
    Clear,
    Unchanged,
}
pub fn memory_change(before: Option<&str>, after: &str) -> MemoryChange {
    let Some(before) = before.filter(|s| !s.trim().is_empty()) else {
        return if after.trim().is_empty() {
            MemoryChange::Unchanged
        } else {
            MemoryChange::Initial
        };
    };
    if after.trim().is_empty() {
        return MemoryChange::Clear;
    }
    if before == after {
        return MemoryChange::Unchanged;
    }
    let a = sections(before);
    let b = sections(after);
    let unique = |s: &[Section]| {
        let mut keys = std::collections::HashSet::new();
        s.iter().all(|x| keys.insert(&x.heading))
    };
    let retained: Vec<_> = b
        .iter()
        .filter(|n| a.iter().any(|o| o.heading == n.heading))
        .collect();
    if !unique(&a)
        || !unique(&b)
        || retained.len() != a.len()
        || retained
            .iter()
            .zip(&a)
            .any(|(n, o)| n.heading != o.heading || n.hash != o.hash)
    {
        return MemoryChange::Reread;
    }
    let added: Vec<_> = b
        .iter()
        .filter(|n| !a.iter().any(|o| o.heading == n.heading))
        .map(|s| s.text.clone())
        .collect();
    if added.is_empty() {
        MemoryChange::Unchanged
    } else {
        MemoryChange::Append(added)
    }
}
