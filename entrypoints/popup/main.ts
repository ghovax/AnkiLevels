const deckNameInput = document.getElementById("deckName") as HTMLInputElement;
const saveBtn = document.getElementById("saveBtn") as HTMLButtonElement;
const statusDiv = document.getElementById("status") as HTMLDivElement;

// Load saved deck name
browser.storage.local.get("deckName").then((result) => {
  if (result.deckName) {
    deckNameInput.value = result.deckName;
  } else {
    // Set default deck name
    deckNameInput.value = "Japanese";
  }
});

function showStatus(message: string, isError = false) {
  statusDiv.textContent = message;
  statusDiv.className = `status ${isError ? "error" : "success"}`;
  statusDiv.style.display = "block";
  setTimeout(() => {
    statusDiv.style.display = "none";
  }, 3000);
}

saveBtn.addEventListener("click", async () => {
  const deckName = deckNameInput.value.trim();
  if (!deckName) {
    showStatus("Please enter a deck name", true);
    return;
  }

  try {
    // Save to storage
    await browser.storage.local.set({ deckName });
    showStatus("Settings saved!");
    // Tell background script to refresh
    await browser.runtime.sendMessage({ action: "refreshWords" });
  } catch (error) {
    console.error("Error saving:", error);
    showStatus("Error saving settings", true);
  }
});
