-- Owner reminder emails are opt-in. In-app reminders remain available.
ALTER TABLE businesses ADD COLUMN owner_reminder_email_enabled INTEGER NOT NULL DEFAULT 0 CHECK (owner_reminder_email_enabled IN (0, 1));
