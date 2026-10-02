import { Select } from '@closurestudio/ui';
import type { AgentProp } from '@ouispec/bindings';

const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'French' },
];

export function LanguageField({
  value,
  onChange,
  agent,
}: {
  value: string;
  onChange: (v: string) => void;
  agent?: AgentProp;
}) {
  return <Select label="Language" value={value} options={LANGUAGES} onChange={onChange} agent={agent} />;
}

// Used twice in its own file: each use is its own binding.
export function TwoLanguages() {
  return (
    <>
      <LanguageField
        value="en"
        onChange={() => {}}
        agent={{ id: 'create.subtitle-language', description: 'Subtitles' }}
      />
      <LanguageField
        value="en"
        onChange={() => {}}
        agent={{ id: 'create.dub-language', description: 'Dubbing' }}
      />
    </>
  );
}
