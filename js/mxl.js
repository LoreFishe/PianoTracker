/** Unpacks a compressed .mxl file (a zip containing MusicXML) and returns
 * the inner MusicXML as plain text. */
export async function parseMxl(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);

  const containerFile = zip.file("META-INF/container.xml");
  let entryPath = null;
  if (containerFile) {
    const containerText = await containerFile.async("text");
    const doc = new DOMParser().parseFromString(containerText, "application/xml");
    entryPath = doc.querySelector("rootfile")?.getAttribute("full-path") ?? null;
  }

  if (!entryPath || !zip.file(entryPath)) {
    entryPath = Object.keys(zip.files).find(
      (name) => !name.startsWith("META-INF/") && /\.(musicxml|xml)$/i.test(name)
    );
  }

  if (!entryPath) {
    throw new Error("Could not find a MusicXML file inside this .mxl archive.");
  }

  return zip.file(entryPath).async("text");
}
