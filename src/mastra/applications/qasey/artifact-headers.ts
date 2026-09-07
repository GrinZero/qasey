/** Keep header bytes ASCII while preserving Unicode download names via RFC 5987. */
export function artifactContentDisposition(name: string): string {
  const basename = (name.replace(/\\/gu, "/").split("/").at(-1) ?? "")
    .replace(/[\u0000-\u001f\u007f]/gu, "_").toWellFormed();
  const filename = !basename || basename === "." || basename === ".." ? "artifact" : basename;
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/gu, "_");
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/gu, character =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
