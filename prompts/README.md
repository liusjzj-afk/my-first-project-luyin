# Summary Prompt Templates

`services.llm_service.load_summary_prompt()` loads `./prompts/{meeting_type}.md`.

- `default.md` is optional. If a template is missing, the built-in BA summary prompt is used.
- Future commercial templates can add files such as `sales-discovery.md`, `prd-review.md`, or `customer-interview.md`.
- The `meeting_type` field on `Meeting` controls which template is selected.
