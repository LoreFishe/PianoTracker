import { parseMxl } from "./mxl.js?v=20260727-7";

/** Reads an uploaded File (.musicxml/.xml/.mxl) and returns its MusicXML text. */
export async function readUploadedFile(file) {
  const isCompressed = /\.mxl$/i.test(file.name);
  if (isCompressed) {
    const buffer = await file.arrayBuffer();
    return parseMxl(buffer);
  }
  return file.text();
}

function formatProgressSummary(entry) {
  if (entry.progress.completed) return "Completed";
  if (entry.progress.stepIndex > 0) return `In progress (step ${entry.progress.stepIndex})`;
  return "Not started";
}

function formatDate(timestamp) {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Renders the library list into `container` as compact sidebar nav items.
 * Entries are sorted most-recently-updated first. `activeId` (if it matches
 * an entry) gets the highlighted/open styling instead of a fixed "Practice"
 * button, since the sidebar is always visible alongside whatever's open. */
export function renderLibraryList(container, entries, { activeId = null, onOpen, onDelete }) {
  container.innerHTML = "";

  if (entries.length === 0) {
    const empty = document.createElement("li");
    empty.className = "library-empty";
    empty.textContent = "No pieces yet — upload a .musicxml, .xml, or .mxl file to get started.";
    container.appendChild(empty);
    return;
  }

  const sorted = [...entries].sort((a, b) => b.updatedAt - a.updatedAt);

  for (const entry of sorted) {
    const item = document.createElement("li");
    item.className = "library-item";
    item.classList.toggle("active", entry.id === activeId);

    const glyph = document.createElement("span");
    glyph.className = "glyph";
    glyph.textContent = "♪";

    const text = document.createElement("span");
    text.className = "library-item-text";
    const title = document.createElement("span");
    title.className = "library-item-title";
    title.textContent = entry.fileName;
    const meta = document.createElement("span");
    meta.className = "library-item-meta";
    meta.textContent = `${formatProgressSummary(entry)} · Updated ${formatDate(entry.updatedAt)}`;
    text.appendChild(title);
    text.appendChild(meta);

    const deleteButton = document.createElement("button");
    deleteButton.className = "library-item-delete";
    deleteButton.type = "button";
    deleteButton.title = `Delete "${entry.fileName}"`;
    deleteButton.textContent = "✕";
    deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      if (confirm(`Delete "${entry.fileName}"? This can't be undone.`)) {
        onDelete(entry.id);
      }
    });

    item.appendChild(glyph);
    item.appendChild(text);
    item.appendChild(deleteButton);
    item.addEventListener("click", () => onOpen(entry.id));
    container.appendChild(item);
  }
}
