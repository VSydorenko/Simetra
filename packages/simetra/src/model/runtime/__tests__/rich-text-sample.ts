import type { RichTextDocument } from "../rich-text"

/**
 * Документ з усіма вузлами й позначками профілю у формі `getJSON` Tiptap
 * StarterKit 3.35.0, написаний руками за джерелами пакетів
 * (`pkg-src @tiptap/<пакет>@3.35.0`, `prosemirror-model` `Node.toJSON`):
 * `attrs` — лише у вузлів з атрибутами й з усіма атрибутами, включно з
 * типовими; `content` і `marks` — лише непорожні. Посилання несе типові
 * `target`/`rel` розширення `Link`; `hardBreak` усередині жирного тексту —
 * з позначкою, як після вставки `<b>a<br>b</b>`. Доказ рівності зі схемою
 * StarterKit дає тест B8 (Р-B7-12), не цей зразок.
 */
export const STARTER_KIT_SAMPLE: RichTextDocument = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Заголовок" }],
    },
    {
      type: "paragraph",
      content: [
        { type: "text", marks: [{ type: "bold" }], text: "жирний" },
        { type: "hardBreak", marks: [{ type: "bold" }] },
        { type: "text", marks: [{ type: "italic" }], text: "курсив " },
        {
          type: "text",
          marks: [{ type: "strike" }, { type: "underline" }],
          text: "закреслений",
        },
        { type: "text", text: " " },
        { type: "text", marks: [{ type: "code" }], text: "код" },
        { type: "hardBreak" },
        {
          type: "text",
          marks: [
            {
              type: "link",
              attrs: {
                href: "https://example.com/a?b=1#c",
                target: "_blank",
                rel: "noopener noreferrer nofollow",
                class: null,
                title: null,
              },
            },
          ],
          text: "посилання",
        },
      ],
    },
    { type: "paragraph" },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "пункт" }] },
            {
              type: "orderedList",
              attrs: { start: 3, type: "a" },
              content: [
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "вкладений" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      type: "orderedList",
      attrs: { start: 1, type: null },
      content: [{ type: "listItem", content: [{ type: "paragraph" }] }],
    },
    {
      type: "blockquote",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "цитата" }] },
      ],
    },
    {
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [{ type: "text", text: "const a = 1\n" }],
    },
    { type: "codeBlock", attrs: { language: null } },
    { type: "horizontalRule" },
  ],
}
