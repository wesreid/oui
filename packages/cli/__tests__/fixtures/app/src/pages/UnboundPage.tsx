import { Button, Carousel, DropdownMenu, SyncedMediaPlayer } from '@closurestudio/ui';
import { Portal, Slider, Sortable } from 'third-party-ui';

declare function menuFromServer(): { id: string; label: string; onClick: () => void }[];
import { LanguageField } from '../LanguageField';

export function UnboundPage() {
  return (
    <>
      <Button onClick={() => {}}>Do it</Button>
      <RawControls />
      <ThirdParty />
      <LanguageField value="en" onChange={() => {}} />
      <SyncedMediaPlayer tracks={[]} />
      <DropdownMenu label="More" trigger={<span>More</span>} items={menuFromServer()} />
    </>
  );
}

export function RawControls() {
  return (
    <div>
      <button onClick={() => {}}>Raw</button>
      <div onClick={() => {}} data-non-agent="the canvas takes pointer drags">
        canvas
      </div>
      <input type="file" hidden />
      <div onKeyDown={() => {}}>keys</div>
      <canvas onPointerDown={() => {}} />
      <span onMouseDown={() => {}} data-non-agent="a drag handle: the rows' move buttons reorder them" />
    </div>
  );
}

/** Components of a library that is not the design system, and hosts no room. */
export function ThirdParty() {
  return (
    <Portal>
      <Slider value={3} onValueChange={() => {}} />
      <Sortable onDragEnd={() => {}} data-non-agent="dragging only reorders; the move buttons do the same" />
      <Carousel onSlide={() => {}} />
    </Portal>
  );
}
