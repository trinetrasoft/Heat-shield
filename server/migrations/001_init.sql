CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  timezone text DEFAULT 'Asia/Dubai' NOT NULL,
  settings jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id),
  login_id text NOT NULL,
  role_label text NOT NULL,
  role text NOT NULL,
  password_hash text NOT NULL,
  must_change_password boolean DEFAULT true NOT NULL,
  active boolean DEFAULT true NOT NULL,
  failed_logins integer DEFAULT 0 NOT NULL,
  locked_until timestamptz,
  language text DEFAULT 'en' NOT NULL,
  last_login_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT users_role_check CHECK (role IN ('org_admin','safety_lead','supervisor','worker','analyst')),
  CONSTRAINT users_login_lower CHECK (login_id = lower(login_id)),
  CONSTRAINT users_language_check CHECK (language IN ('en','hi','ar'))
);
CREATE UNIQUE INDEX users_login_unique ON users (login_id);

CREATE TABLE sessions (
  id text PRIMARY KEY NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now() NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE login_attempts (
  id bigserial PRIMARY KEY NOT NULL,
  key text NOT NULL,
  at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX login_attempts_key ON login_attempts (key, at);

CREATE TABLE sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  code text NOT NULL,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  timezone text NOT NULL,
  environment text DEFAULT 'outdoor' NOT NULL,
  facilities jsonb NOT NULL,
  has_wbgt_instrument boolean DEFAULT false NOT NULL,
  active boolean DEFAULT true NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT sites_environment_check CHECK (environment IN ('outdoor','indoor','mixed')),
  CONSTRAINT sites_code_unique UNIQUE (org_id, code)
);

CREATE TABLE user_sites (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, site_id)
);

CREATE TABLE crews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id),
  site_id uuid NOT NULL REFERENCES sites(id),
  name text NOT NULL,
  work_area text NOT NULL,
  task_intensity text NOT NULL,
  clothing text NOT NULL,
  acclimatization text NOT NULL,
  shift_start text NOT NULL,
  shift_end text NOT NULL,
  active boolean DEFAULT true NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT crews_intensity_check CHECK (task_intensity IN ('light','moderate','heavy','very_heavy')),
  CONSTRAINT crews_clothing_check CHECK (clothing IN ('standard','coveralls','double_layer','vapour_barrier')),
  CONSTRAINT crews_acclimatization_check CHECK (acclimatization IN ('acclimatized','mixed','new_workers'))
);

CREATE TABLE protocols (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id),
  version integer NOT NULL,
  name text NOT NULL,
  status text NOT NULL,
  config jsonb NOT NULL,
  notes text,
  created_by uuid REFERENCES users(id),
  submitted_by uuid REFERENCES users(id),
  submitted_at timestamptz,
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT protocols_status_check CHECK (status IN ('draft','pending_approval','approved','retired','rejected')),
  CONSTRAINT protocols_two_person CHECK (approved_by IS NULL OR submitted_by IS NULL OR approved_by <> submitted_by)
);
CREATE UNIQUE INDEX protocols_org_version ON protocols (org_id, version);
CREATE UNIQUE INDEX protocols_one_approved ON protocols (org_id) WHERE status = 'approved';

CREATE TABLE readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id),
  site_id uuid NOT NULL REFERENCES sites(id),
  source text NOT NULL,
  observed_at timestamptz NOT NULL,
  received_at timestamptz DEFAULT now() NOT NULL,
  air_temp_c double precision,
  relative_humidity double precision,
  wind_ms double precision,
  wbgt_c double precision,
  heat_index_c double precision,
  provider text,
  recorded_by uuid REFERENCES users(id),
  quality jsonb DEFAULT '[]'::jsonb NOT NULL,
  notes text,
  CONSTRAINT readings_source_check CHECK (source IN ('forecast','current','onsite_wbgt','manual')),
  CONSTRAINT readings_ranges CHECK (
    (air_temp_c IS NULL OR air_temp_c BETWEEN -40 AND 65) AND
    (relative_humidity IS NULL OR relative_humidity BETWEEN 0 AND 100) AND
    (wbgt_c IS NULL OR wbgt_c BETWEEN -10 AND 50) AND
    (wind_ms IS NULL OR wind_ms BETWEEN 0 AND 80)
  )
);
CREATE INDEX readings_site_time ON readings (site_id, observed_at);

CREATE TABLE assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id),
  site_id uuid NOT NULL REFERENCES sites(id),
  crew_id uuid NOT NULL REFERENCES crews(id),
  protocol_id uuid REFERENCES protocols(id),
  protocol_version integer,
  reading_id uuid REFERENCES readings(id),
  assessed_at timestamptz NOT NULL,
  assessed_by uuid REFERENCES users(id),
  trigger text NOT NULL,
  metric text NOT NULL,
  metric_value double precision,
  adjusted_value double precision,
  risk_level text NOT NULL,
  basis text NOT NULL,
  data_issues jsonb NOT NULL,
  reasons jsonb NOT NULL,
  controls jsonb NOT NULL,
  requires_human_review boolean DEFAULT false NOT NULL,
  CONSTRAINT assessments_risk_check CHECK (risk_level IN ('low','moderate','high','extreme','unknown')),
  CONSTRAINT assessments_basis_check CHECK (basis IN ('measured','estimated','insufficient'))
);
CREATE INDEX assessments_crew_time ON assessments (crew_id, assessed_at);

CREATE TABLE actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id),
  site_id uuid NOT NULL REFERENCES sites(id),
  crew_id uuid REFERENCES crews(id),
  assessment_id uuid REFERENCES assessments(id),
  control_id text NOT NULL,
  title text NOT NULL,
  instructions text NOT NULL,
  priority text NOT NULL,
  status text DEFAULT 'open' NOT NULL,
  assigned_role text NOT NULL,
  source text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  ack_due_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES users(id),
  completed_at timestamptz,
  completed_by uuid REFERENCES users(id),
  barrier text,
  resolution_note text,
  escalation_level integer DEFAULT 0 NOT NULL,
  last_escalated_at timestamptz,
  CONSTRAINT actions_status_check CHECK (status IN ('open','acknowledged','completed','blocked','cancelled')),
  CONSTRAINT actions_priority_check CHECK (priority IN ('routine','high','urgent')),
  CONSTRAINT actions_role_check CHECK (assigned_role IN ('supervisor','safety_lead')),
  CONSTRAINT actions_source_check CHECK (source IN ('assessment','worker_report','manual'))
);
CREATE INDEX actions_site_status ON actions (site_id, status);
CREATE INDEX actions_due ON actions (status, due_at);

CREATE TABLE action_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id),
  action_id uuid NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
  at timestamptz NOT NULL,
  actor_id uuid REFERENCES users(id),
  actor_role text,
  type text NOT NULL,
  detail jsonb DEFAULT '{}'::jsonb NOT NULL
);
CREATE INDEX action_events_action ON action_events (action_id, at);

CREATE TABLE instruction_acks (
  assessment_id uuid NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at timestamptz NOT NULL,
  PRIMARY KEY (assessment_id, user_id)
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now() NOT NULL,
  read_at timestamptz,
  kind text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  link text
);
CREATE INDEX notifications_user ON notifications (user_id, created_at);

CREATE TABLE worker_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id),
  site_id uuid NOT NULL REFERENCES sites(id),
  crew_id uuid REFERENCES crews(id),
  type text NOT NULL,
  location text,
  note text,
  action_id uuid REFERENCES actions(id),
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT worker_reports_type_check CHECK (type IN ('no_water','no_shade','no_rest_area','someone_unwell','other'))
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id),
  at timestamptz DEFAULT now() NOT NULL,
  actor_id uuid,
  actor_role text,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  summary text NOT NULL,
  meta jsonb DEFAULT '{}'::jsonb NOT NULL
);
CREATE INDEX audit_org_time ON audit_log (org_id, at);

CREATE OR REPLACE FUNCTION audit_log_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('heatshield.allow_audit_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_change ON audit_log;
CREATE TRIGGER audit_log_no_change
BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION audit_log_guard();
