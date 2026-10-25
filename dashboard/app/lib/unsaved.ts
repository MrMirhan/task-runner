// One flag for "a rule document has edits that are not saved". The editor sets it; tab switches,
// sign-out and the document list read it before they throw the edits away.
let unsaved = false;

export function setUnsaved(value: boolean): void {
  unsaved = value;
}

export function confirmDiscard(): boolean {
  return !unsaved || window.confirm("You have unsaved changes to a rule document. Discard them?");
}
