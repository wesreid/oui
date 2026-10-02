import { BOARD_CATALOG } from './board-actions';
import { useRoom } from './useRoom';

export function useBoard() {
  useRoom(BOARD_CATALOG);
}
