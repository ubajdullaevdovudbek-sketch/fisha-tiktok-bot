ALTER TABLE videos ADD COLUMN publishing_started_at TEXT;

UPDATE videos SET status='uncertain', error='Migration safety hold: previous job was processing during duplicate-protection rollout' WHERE status='processing';
