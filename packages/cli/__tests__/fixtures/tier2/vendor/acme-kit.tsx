/**
 * A stand-in for a third-party design system the app does not own: MUI-style
 * `onPick(event, id)`, a press with no value, and a compound menu.
 */
import type { ReactNode } from 'react';

export interface PickerProps {
  label?: string;
  value?: string;
  options: readonly { id: string; name: string }[];
  onPick?: (event: { type: 'pick' }, id: string) => unknown;
  disabled?: boolean;
}

export function Picker(_props: PickerProps) {
  return null;
}

export function Press(_props: { children?: ReactNode; onPress?: () => unknown }) {
  return null;
}

function MenuRoot(_props: { label?: string; selected?: string; onSelect?: (id: string) => unknown; children?: ReactNode }) {
  return null;
}

function MenuChoice(_props: { id: string; children?: ReactNode; disabled?: boolean }) {
  return null;
}

function MenuLabel(_props: { children?: ReactNode }) {
  return null;
}

export const Menu = { Root: MenuRoot, Choice: MenuChoice, Label: MenuLabel };
