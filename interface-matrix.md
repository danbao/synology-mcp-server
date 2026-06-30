# Synology Product Interface Matrix

This matrix is used by smoke tests and mock assertions to prevent API drift.

## Drive

| MCP tool | Synology API | Version | HTTP | Request shape | Writes |
| --- | --- | ---: | --- | --- | --- |
| `drive_list_files` | `SYNO.SynologyDrive.Files.list` | 2 | GET | query | no |
| `drive_get_file_info` | `SYNO.SynologyDrive.Files.get` | 2 | GET | query | no |
| `drive_search_files` | `SYNO.SynologyDrive.Files.search` | 2 | GET | query | no |
| `drive_download_file` | `SYNO.SynologyDrive.Files.download` | 2 | GET | query + cookie | no |
| `drive_upload_file` | `SYNO.SynologyDrive.Files.upload` | 2 | POST | query api + multipart body | yes |
| `drive_create_folder` | `SYNO.SynologyDrive.Files.create` | 2 | POST | query api + form body (`path`, `type=folder`) | yes |
| `drive_move_file` | `Files.get` + `SYNO.SynologyDrive.Files.move/update` | 2 | POST | resolve ids, then form body (`files`, `to_parent_folder`) | yes |
| `drive_delete_file` | `Files.get` + `SYNO.SynologyDrive.Files.delete` + `SYNO.SynologyDrive.Tasks.get` | 10/1 | POST | resolve id, form body (`files`, `permanent`), then compound task status check | yes |
| `drive_list_labels` | `SYNO.SynologyDrive.Labels.list` | 3 | GET | query | no |
| `drive_add_label` | `Files.get` + `SYNO.SynologyDrive.Files.label` | 2 | POST | resolve id, then form body (`files`, `labels`) | yes |
| `drive_get_sharing_link` | `Files.get` + `SYNO.SynologyDrive.Sharing.create_link` | 1 | POST | resolve id, then form body (`path=id:<file_id>`) | yes |

## Spreadsheet

| MCP tool | Spreadsheet API path | HTTP | Request shape | Writes |
| --- | --- | --- | --- | --- |
| `spreadsheet_list` | Drive `Files.list` filtered to spreadsheets | GET | query | no |
| `spreadsheet_get_info` | `/spreadsheets/{id}` | GET | REST path | no |
| `spreadsheet_read_sheet` | `/spreadsheets/{id}/values/{range}` | GET | REST path | no |
| `spreadsheet_get_styles` | `/spreadsheets/{id}/styles/{range}` | GET | REST path | no |
| `spreadsheet_export` | `/spreadsheets/{id}/xlsx` or `/sheet/csv` | GET | REST path/query | no |
| `spreadsheet_create` | `/spreadsheets/create` | POST | JSON body | yes |
| `spreadsheet_write_cells` | `/spreadsheets/{id}/values/{range}` | PUT | JSON body | yes |
| `spreadsheet_append_rows` | `/spreadsheets/{id}/values/{range}/append` | PUT | JSON body | yes |
| `spreadsheet_add_sheet` | `/spreadsheets/{id}/sheet/add` | POST | JSON body | yes |
| `spreadsheet_rename_sheet` | `/spreadsheets/{id}/sheet/rename` | POST | JSON body | yes |
| `spreadsheet_delete_sheet` | `/spreadsheets/{id}/sheet/delete` | POST | JSON body | yes |
| `spreadsheet_batch_update` | `/spreadsheets/{id}/batchUpdate` | POST | JSON body | yes |
| `spreadsheet_write_styles` | `/spreadsheets/{id}/styles` | PUT | JSON body | yes |
| `spreadsheet_delete_file` | `/spreadsheets/delete` | POST | JSON body | yes |
| `spreadsheet_register` | local cache only | n/a | local | yes |

## Calendar

| MCP tool | Synology API | Version | HTTP | Request shape | Writes |
| --- | --- | ---: | --- | --- | --- |
| `calendar_list_calendars` | `SYNO.Cal.Cal.list` | 1 | GET | query | no |
| `calendar_list_events` | `SYNO.Cal.Event.list` | 6 | GET | JSON-encoded query params, response `list` normalized to `events` | no |
| `calendar_get_event` | `SYNO.Cal.Event.get` | 6 | POST | query api + JSON-encoded form body | no |
| `calendar_create_event` | `SYNO.Cal.Event.create` | 6 | POST | query api + JSON-encoded form body | yes |
| `calendar_update_event` | `SYNO.Cal.Event.set` | 6 | POST | query api + JSON-encoded form body | yes |
| `calendar_delete_event` | `SYNO.Cal.Event.delete` | 6 | POST | query api + JSON-encoded form body | yes |
| `calendar_create_calendar` | `SYNO.Cal.Cal.create` | 5 | POST | query api + JSON-encoded form body | yes |

## MailPlus

| MCP tool | Synology API | Version | HTTP | Request shape | Writes |
| --- | --- | ---: | --- | --- | --- |
| `mailplus_list_folders` | `SYNO.MailClient.Mailbox.list` | 7 | GET | query | no |
| `mailplus_list_messages` | `SYNO.MailClient.Thread.list` | 10 | GET | query | no |
| `mailplus_get_message` | `SYNO.MailClient.Message.get` | 10 | GET | query | no |
| attachment content | `SYNO.MailClient.Attachment.download` | 8 | GET | query + cookie | no |
| `mailplus_send_message` | `Attachment.upload` + `Draft.create/send` | 7/6 | POST | multipart + form body | yes |
| `mailplus_mark_messages` | `Message.set_read` or `Message.set_star` | 10 | POST | form body | yes |
| `mailplus_move_messages` | `Message.set_mailbox` | 10 | POST | form body | yes |

## Download Station

| MCP tool | Synology API | Version | HTTP | Request shape | Writes |
| --- | --- | ---: | --- | --- | --- |
| `download_list_tasks` | `SYNO.DownloadStation.Task.list` | 1 | GET | query (`offset`, `limit`, `additional`) | no |
| `download_get_task` | `SYNO.DownloadStation.Task.getinfo` | 1 | GET | query (`id`, `additional`) | no |
| `download_create_task` | `SYNO.DownloadStation.Task.create` | 1 | POST | query api + form body (`uri`, optional `destination`) | yes |
| `download_pause_tasks` | `SYNO.DownloadStation.Task.pause` | 1 | POST | query api + form body (`id`) | yes |
| `download_resume_tasks` | `SYNO.DownloadStation.Task.resume` | 1 | POST | query api + form body (`id`) | yes |
| `download_delete_tasks` | `SYNO.DownloadStation.Task.delete` | 1 | POST | query api + form body (`id`, `force_complete=false`) | yes |

## System

| MCP tool | Synology API | Version | HTTP | Request shape | Writes |
| --- | --- | ---: | --- | --- | --- |
| `synology_list_capabilities` | `SYNO.API.Info.query` + module probes | 1 | GET | availability probes per enabled module | no |

## Real Smoke Defaults

- `pnpm smoke:readonly` validates only non-destructive calls.
- `pnpm smoke:write` creates temporary resources named `synology-mcp-smoke-<timestamp>` and moves Drive cleanup resources to Drive trash.
- Drive label smoke uses an existing label or creates and deletes a temporary label unless `SMOKE_DRIVE_AUTOCREATE_LABEL=false`.
- MailPlus send smoke uses `SMOKE_MAILPLUS_RECIPIENT`, `SYNO_USERNAME` when it is an email address, or the default MailPlus SMTP sender.
- Download Station write smoke is skipped unless `SMOKE_DOWNLOAD_URI` is set; when enabled it creates a temporary task, verifies get/pause/resume/delete, and keeps cleanup fallback for the created task id.
- Spreadsheet read-only smoke uses `SMOKE_SPREADSHEET_ID` when set. It only auto-picks the first `spreadsheet_list` result when Spreadsheet API and Drive use the same DSM account; with a separate `SYNO_SS_USERNAME`, set an ID that service account can access. Deep read/write smoke is skipped when only an OTP-protected DSM account is available because `/spreadsheets/authorize` does not accept OTP.
