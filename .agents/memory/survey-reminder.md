---
name: Survey reminder (lembrete único da pesquisa)
description: How the one-shot satisfaction-survey reminder works and its invariants
---
Rule: the survey reminder is one-per-atendimento, claimed atomically by setting `conversations.survey_reminder_sent_at` (WHERE reminder IS NULL AND pending_survey_log_id matches) BEFORE sending. If the bridge send fails, the claim stays — losing a reminder beats risking two.

**Why:** anti-ban/anti-spam; a completion review rejected a version that fell back to the CURRENT store config for the response window. The snapshot (`survey_window_hours` written at survey send) is the sole authority; surveys without a snapshot never get reminders.

**How to apply:** eligibility lives in the pure, tested `isSurveyReminderDue` (api-server lib) used by the 60s scheduler tick; per-store toggles `reminderEnabled`/`reminderHours` in survey settings JSON. Any new survey send must reset `survey_reminder_sent_at` to NULL; any consume/clear of the pending survey must clear it too.
