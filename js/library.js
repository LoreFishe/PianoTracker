import { parseMxl } from "./mxl.js?v=20260718-4";

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

/** Renders the library list into `container`. Entries are sorted most-recently-updated first. */
export function renderLibraryList(container, entries, { onOpen, onDelete }) {
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

    const info = document.createElement("div");
    info.className = "library-item-info";
    const title = document.createElement("div");
    title.className = "library-item-title";
    title.textContent = entry.fileName;
    const meta = document.createElement("div");
    meta.className = "library-item-meta";
    meta.textContent = `${formatProgressSummary(entry)} · Updated ${formatDate(entry.updatedAt)}`;
    info.appendChild(title);
    info.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "library-item-actions";

    const openButton = document.createElement("button");
    openButton.textContent = "Practice";
    openButton.addEventListener("click", () => onOpen(entry.id));

    const deleteButton = document.createElement("button");
    deleteButton.textContent = "Delete";
    deleteButton.className = "danger";
    deleteButton.addEventListener("click", () => {
      if (confirm(`Delete "${entry.fileName}"? This can't be undone.`)) {
        onDelete(entry.id);
      }
    });

    actions.appendChild(openButton);
    actions.appendChild(deleteButton);

    item.appendChild(info);
    item.appendChild(actions);
    container.appendChild(item);
  }
}
