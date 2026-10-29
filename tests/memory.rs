use tgfx::memory::{MemoryChange, MemoryOptions, SessionMemory, memory_change};

#[test]
fn code_in_section_headings_keeps_new_sections_distinct() {
    let before = "# `Invoices`\nInclude currency.\n";
    let addition = "# `Vendors`\nUse legal names.";
    assert_eq!(
        memory_change(Some(before), &format!("{before}\n{addition}\n")),
        MemoryChange::Append(vec![addition.into()])
    );
}

#[test]
fn changed_removed_renamed_reordered_and_ambiguous_sections_require_rereading() {
    let original = "# One\nOriginal.\n\n# Two\nKeep.\n";
    for changed in [
        "# One\nRevised.\n\n# Two\nKeep.\n",
        "# One\nOriginal.\n",
        "# Renamed\nOriginal.\n\n# Two\nKeep.\n",
        "# Two\nKeep.\n\n# One\nOriginal.\n",
        "# One\nRevised.\n\n# Two\nKeep.\n\n# Three\nNew.\n",
        "# One\nOriginal.\n\n## Detail\nNew.\n\n# Two\nKeep.\n",
        "# One\nOriginal.\n\n# Two\nKeep.\n\n# One\nDuplicate.\n",
    ] {
        assert_eq!(memory_change(Some(original), changed), MemoryChange::Reread);
    }
    assert_eq!(
        memory_change(
            Some("Original preamble.\n\n# One\nKeep.\n"),
            "Changed preamble.\n\n# One\nKeep.\n"
        ),
        MemoryChange::Reread
    );
    let links = "# Sources\nSee [policy][p].\n\n[p]: https://example.com/old\n";
    assert_eq!(
        memory_change(Some(links), &links.replace("/old", "/new")),
        MemoryChange::Reread
    );
}

#[test]
fn whitespace_between_sections_does_not_turn_an_addition_into_an_edit() {
    assert_eq!(
        memory_change(Some("# One\nKeep.\n"), "# One\nKeep.\n\n# Two\nNew.\n"),
        MemoryChange::Append(vec!["# Two\nNew.".into()])
    );
    assert_eq!(
        memory_change(Some("# One\nKeep.\n"), "# One\nKeep.\n\n"),
        MemoryChange::Unchanged
    );
}

#[test]
fn missing_empty_and_deleted_memory_preserve_the_file_lifecycle_without_a_size_limit() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("MEMORY.md");
    let mut memory = SessionMemory::new(root.path(), MemoryOptions::default()).unwrap();
    assert!(memory.prepare().unwrap().block.is_none());
    assert!(!path.exists());
    let contents = format!("# Facts\n{}", "Long fact. ".repeat(2000));
    for remove in [false, true] {
        std::fs::write(&path, &contents).unwrap();
        let initial = memory.prepare().unwrap();
        assert!(
            initial.block.as_ref().unwrap()["text"]
                .as_str()
                .unwrap()
                .contains(&contents)
        );
        memory.commit(initial);
        if remove {
            std::fs::remove_file(&path).unwrap();
        } else {
            std::fs::write(&path, " \n").unwrap();
        }
        let cleared = memory.prepare().unwrap();
        assert!(
            cleared.block.as_ref().unwrap()["text"]
                .as_str()
                .unwrap()
                .contains("action=\"clear\"")
        );
        memory.commit(cleared);
        assert!(memory.prepare().unwrap().block.is_none());
    }
}

#[test]
fn configured_memory_file_escapes_xml_and_disabled_memory_does_not_read_it() {
    let root = tempfile::tempdir().unwrap();
    let file = "shared&notes.md";
    std::fs::write(
        root.path().join(file),
        "# Facts\nUse <literal> & \"quoted\" names.",
    )
    .unwrap();
    let memory = SessionMemory::new(
        root.path(),
        MemoryOptions {
            enabled: true,
            file: file.into(),
        },
    )
    .unwrap();
    let prepared = memory.prepare().unwrap();
    let text = prepared.block.as_ref().unwrap()["text"].as_str().unwrap();
    assert!(text.contains("source=\"shared&amp;notes.md\""));
    assert!(text.contains("&lt;literal&gt; &amp; &quot;quoted&quot;"));
    let disabled = SessionMemory::new(
        root.path(),
        MemoryOptions {
            enabled: false,
            file: ".".into(),
        },
    )
    .unwrap();
    assert!(disabled.prepare().unwrap().block.is_none());
}
