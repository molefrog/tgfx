import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

await rm("dist", { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  naming: { entry: "tgfx.js" },
  target: "bun",
  minify: true,
  sourcemap: "linked",
  splitting: true,
  external: ["react-devtools-core"],
  metafile: true,
});
if (!result.success) throw new AggregateError(result.logs, "Build failed");

// Bundling also means shipping the dependencies' license notices.
const packages = new Set<string>();
for (const input of Object.keys(result.metafile!.inputs)) {
  const parts = input.split("/");
  const index = parts.lastIndexOf("node_modules");
  if (index < 0) continue;
  packages.add(parts.slice(0, index + (parts[index + 1]!.startsWith("@") ? 3 : 2)).join("/"));
}
const notices: string[] = [];
for (const directory of [...packages].sort()) {
  const pkg = await Bun.file(join(directory, "package.json")).json();
  const files = (await readdir(directory))
    .filter((name) => /^(licen[sc]e|copying|notice)(\.|$)/i.test(name)).sort()
    .map((file) => join(directory, file));
  // yoga-layout omits its license from the npm tarball; keep the upstream copy.
  if (!files.length) files.push(`scripts/licenses/${pkg.name.replaceAll("/", "-")}-${pkg.version}.txt`);
  notices.push(`${pkg.name}@${pkg.version}\n${"=".repeat(72)}`);
  for (const file of files) notices.push(await Bun.file(file).text());
}
await Bun.write("dist/THIRD_PARTY_NOTICES.txt", notices.join("\n\n"));
console.log(`Built ${result.outputs.length} files with notices for ${packages.size} bundled packages.`);
