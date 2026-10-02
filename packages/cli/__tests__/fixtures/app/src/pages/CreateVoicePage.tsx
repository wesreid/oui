import { Button, DropdownMenu, Input, NumericScrubField, Select } from '@closurestudio/ui';
import { LanguageField, TwoLanguages } from '../LanguageField';
import { HALF_HOUR_MS, STYLE_GUIDANCE, STYLE_HINT } from '../copy';

export function CreateVoicePage() {
  // Moods, a menu built with push: one entry per mood, then one to clear them.
  const moods = [];
  for (const mood of ['calm', 'bright']) {
    moods.push({
      id: mood,
      label: mood,
      onClick: () => {},
      agent: { id: 'create.mood', description: 'Add a mood', item: { key: mood, title: mood } },
    });
  }
  moods.push({
    id: 'clear',
    label: 'Clear moods',
    onClick: () => {},
    agent: { id: 'create.mood-clear', description: 'Remove every mood' },
  });
  return (
    <div>
      <NumericScrubField
        label="Pitch"
        min={-12}
        max={12}
        step={1}
        unit="st"
        value={0}
        onChange={() => {}}
        agent={{ id: 'create.pitch', description: 'Pitch shift' }}
      />
      <Select
        label="Language"
        value="en"
        options={[
          { value: 'en', label: 'English' },
          { value: 'fr', label: 'French' },
        ]}
        onChange={() => {}}
        agent={{ id: 'create.language', description: 'Language it speaks' }}
      />
      <LanguageField
        value="en"
        onChange={() => {}}
        agent={{ id: 'create.script-language', description: 'Language of the script' }}
      />
      <LanguageField
        value="fr"
        onChange={() => {}}
        agent={{ id: 'create.accent-language', description: 'Language of the accent' }}
      />
      <TwoLanguages />
      <Button
        onClick={() => ({ ok: true, pending: { jobId: 'job-1' } })}
        agent={{
          id: 'create.generate',
          description: 'Generate a sample of the voice',
          effect: { kind: 'job', estimatedDuration: '10–20 s', timeoutMs: HALF_HOUR_MS },
        }}
      >
        Generate
      </Button>
      <Input
        label="Style"
        value=""
        onChange={() => {}}
        hint={STYLE_HINT}
        placeholder="Name, face, hair and clothing"
        agent={{ id: 'create.style', description: `The character style. ${STYLE_GUIDANCE}` }}
      />
      <Input
        label="Notes"
        value=""
        onChange={() => {}}
        hint={`${0} / 500`.length > 0 ? 'Anything else' : 'Nothing'}
        agent={{ id: 'create.notes', description: 'Notes on the voice' }}
      />
      <Input
        label="Name"
        value=""
        onChange={() => {}}
        placeholder="Warm narrator"
        agent={{ id: 'create.name', description: 'The voice’s name. Required' }}
      />
      <DropdownMenu label="Moods" trigger={<span>Moods</span>} items={moods} />
      <DropdownMenu
        label="Add direction"
        trigger={<span>Add direction</span>}
        items={['whisper', 'excited'].map(tag => ({
          id: tag,
          label: tag,
          onClick: () => {},
          agent: {
            id: 'create.direction',
            description: 'Insert a direction tag',
            item: { key: tag, title: tag },
          },
        }))}
      />
    </div>
  );
}
