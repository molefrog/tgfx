import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionMemory, memorySections } from "../src/memory";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "tgfx-memory-"));
  roots.push(root);
  const memory = new SessionMemory(root, options);
  return { root, memory, write: (text: string) => writeFile(join(root, "MEMORY.md"), text) };
}
async function turn(memory: SessionMemory) {
  const update = await memory.prepare();
  update.commit();
  return update.block?.type === "text" ? update.block.text : undefined;
}

test("missing memory is silent and the first file is included without a size limit", async () => {
  const f = await fixture();
  expect(await turn(f.memory)).toBeUndefined();
  const text = "# Facts\n" + "Long fact. ".repeat(2000);
  await f.write(text);
  expect(await turn(f.memory)).toContain(text);
  expect(await turn(f.memory)).toBeUndefined();
});

test("only newly added top-level sections are sent", async () => {
  const f = await fixture();
  await f.write("# Invoices\nInclude currency.\n");
  await turn(f.memory);
  await f.write("# Invoices\nInclude currency.\n\n# Vendors\nUse legal names.\n");
  const update = await turn(f.memory);
  expect(update).toContain('action="append"');
  expect(update).toContain("# Vendors");
  expect(update).not.toContain("Include currency");
  expect(await turn(f.memory)).toBeUndefined();
});

test.each([
  ["changed section", "# One\nRevised.\n\n# Two\nKeep.\n"],
  ["removed section", "# One\nOriginal.\n"],
  ["renamed section", "# Renamed\nOriginal.\n\n# Two\nKeep.\n"],
  ["reordered sections", "# Two\nKeep.\n\n# One\nOriginal.\n"],
  ["changed and added", "# One\nRevised.\n\n# Two\nKeep.\n\n# Three\nNew.\n"],
])("%s asks for a reread instead of resending content", async (_name, text) => {
  const f = await fixture();
  await f.write("# One\nOriginal.\n\n# Two\nKeep.\n");
  await turn(f.memory);
  await f.write(text);
  const update = await turn(f.memory);
  expect(update).toContain('action="reread"');
  expect(update).toContain("Read MEMORY.md");
  expect(update).not.toContain("# One");
  expect(update).not.toContain("# Three");
});

test("preamble is tracked and new subheadings count as edits to their section", async () => {
  const f = await fixture();
  await f.write("General note.\n\n# One\nOriginal.\n");
  await turn(f.memory);
  await f.write("General note.\n\n# One\nOriginal.\n\n## Detail\nNew.\n");
  expect(await turn(f.memory)).toContain('action="reread"');
  await f.write("Changed note.\n\n# One\nOriginal.\n\n## Detail\nNew.\n");
  expect(await turn(f.memory)).toContain('action="reread"');
});

test.each([false, true])("empty or deleted memory clears the old snapshot (delete=%s)", async remove => {
  const f = await fixture();
  await f.write("# One\nOriginal.\n");
  await turn(f.memory);
  if (remove) await rm(join(f.root, "MEMORY.md")); else await f.write(" \n");
  expect(await turn(f.memory)).toContain('action="clear"');
  expect(await turn(f.memory)).toBeUndefined();
  await f.write("# Two\nNew.\n");
  expect(await turn(f.memory)).toContain('<memory source="MEMORY.md">');
});

test("parser recognizes Setext headings and ignores fenced or quoted headings", () => {
  const sections = memorySections("Preamble\n\nTitle\n=====\n\n```md\n# Example\n```\n\n> # Quoted\n\n## Detail\n\n# Real\nBody\n");
  expect(sections.map(section => section.heading)).toEqual([null, "Title", "Real"]);
  expect(sections[1]?.text).toContain("# Example");
});

test("ambiguous duplicate headings require a reread", async () => {
  const f = await fixture();
  await f.write("# Same\nFirst.\n\n# Same\nSecond.\n");
  await turn(f.memory);
  await f.write("# Same\nFirst.\n\n# Same\nSecond.\n\n# New\nThird.\n");
  expect(await turn(f.memory)).toContain('action="reread"');
});

test("reference link definitions remain in section content and trigger rereads", async () => {
  const f = await fixture();
  const original = "# Sources\nSee [policy][p].\n\n[p]: https://example.com/old\n";
  expect(memorySections(original)[0]?.text).toContain("[p]: https://example.com/old");
  await f.write(original);
  await turn(f.memory);
  await f.write(original.replace("/old", "/new"));
  expect(await turn(f.memory)).toContain('action="reread"');
});

test("each conversation has its own cursor and failed delivery can be retried", async () => {
  const f = await fixture();
  const other = new SessionMemory(f.root);
  await f.write("# One\nFirst.\n");
  expect((await f.memory.prepare()).block).toBeDefined();
  expect(await turn(f.memory)).toContain('<memory source="MEMORY.md">');
  await f.write("# One\nFirst.\n\n# Two\nSecond.\n");
  expect(await turn(f.memory)).toContain('action="append"');
  expect(await turn(other)).toContain("# One");
});

test("memory can be disabled or read from a configured file", async () => {
  const f = await fixture({ enabled: false });
  await f.write("# One\nFirst.\n");
  expect(await turn(f.memory)).toBeUndefined();
  await mkdir(join(f.root, "notes"));
  await writeFile(join(f.root, "notes/shared.md"), "Custom & <literal> memory");
  const custom = new SessionMemory(f.root, { file: "notes/shared.md" });
  const update = await turn(custom);
  expect(update).toContain('source="notes/shared.md"');
  expect(update).toContain("Custom &amp; &lt;literal&gt; memory");
});

test("memory cannot escape the working directory through paths or symlinks", async () => {
  const f = await fixture();
  expect(() => new SessionMemory(f.root, { file: "../private.md" })).toThrow("inside");
  expect(() => new SessionMemory(f.root, { file: "/private.md" })).toThrow("inside");
  const outside = await fixture();
  await outside.write("Private");
  await symlink(join(outside.root, "MEMORY.md"), join(f.root, "MEMORY.md"));
  await expect(f.memory.prepare()).rejects.toThrow("inside");
});
