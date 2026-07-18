const SAMPLE_FILE_URL = "samples/sample-grand-staff.musicxml";

async function loadSample() {
  const container = document.getElementById("osmd-container");
  const osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(container, {
    autoResize: true,
    drawTitle: true,
  });

  const response = await fetch(SAMPLE_FILE_URL);
  const musicXmlText = await response.text();

  await osmd.load(musicXmlText);
  osmd.render();
}

loadSample().catch((err) => {
  console.error("Failed to load sample score:", err);
  const container = document.getElementById("osmd-container");
  container.textContent = "Failed to load sample score. See console for details.";
});
