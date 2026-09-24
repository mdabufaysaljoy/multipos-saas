/**
 * Hands a downloaded file to the browser.
 *
 * The server names the file (Content-Disposition); this only saves it, and
 * always releases the object URL afterwards.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
