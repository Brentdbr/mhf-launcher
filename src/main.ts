import { app } from "electron";
import { launchMhf } from "./mhf-launch";

app.whenReady().then(async () => {
  // TEMPORARY — remove once you wire up the real UI
  try {
    const config = await launchMhf({ onLog: (line) => console.log(line) });
    console.log("launched:", config.char_name);
  } catch (err) {
    console.error("launch failed:", err);
  }
});