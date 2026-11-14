// Copy buttons: <button data-copy="text to copy">Copy</button>
for (const button of document.querySelectorAll('button[data-copy]')) {
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
    } catch {
      return;
    }
    const label = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => {
      button.textContent = label;
    }, 1500);
  });
}
