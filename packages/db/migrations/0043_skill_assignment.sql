ALTER TABLE entities ADD COLUMN skill_assignment_mode text NOT NULL DEFAULT 'approval';
ALTER TABLE agent_skills ADD COLUMN created_by_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL;
