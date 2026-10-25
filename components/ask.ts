/** Small event bus so buttons on the page can open the chat with a question already typed. */
export const ASK_EVENT = "wb-assistant-ask";

export function askAssistant(question: string): void {
  window.dispatchEvent(new CustomEvent(ASK_EVENT, { detail: question }));
}
