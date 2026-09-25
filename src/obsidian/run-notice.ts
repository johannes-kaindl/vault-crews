/** Notice mit einem Klick-Weg. Obsidian nimmt fuer eine Notice ein DocumentFragment an;
 *  ohne DOM (Unit-Tests) faellt sie auf den reinen Text zurueck. */
export const NOTICE_WITH_LINK_MS = 12_000;

export function noticeWithLink(text: string, linkLabel: string, onClick: () => void): string | DocumentFragment {
  if (typeof createFragment !== "function") return text;
  return createFragment((frag) => {
    frag.appendText(`${text} `);
    const a = frag.createEl("a", { text: linkLabel, cls: "vault-crews-notice-link" });
    a.addEventListener("click", (e) => {
      e.preventDefault();
      onClick();
    });
  });
}
