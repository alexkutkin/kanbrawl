export type BoardErrorCode =
  | 'TASK_NOT_FOUND'
  | 'COLUMN_NOT_FOUND'
  | 'DUPLICATE_COLUMN'
  | 'INVALID_COLUMNS'
  | 'INVALID_TITLE'
  | 'INVALID_DESCRIPTION'
  | 'INVALID_ASSIGNEE'
  | 'INVALID_PRIORITY'
  | 'CONFLICT'
  | 'BOARD_LOCKED'
  | 'INVALID_BOARD_FILE';

export class BoardError extends Error {
  constructor(
    readonly code: BoardErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BoardError';
  }
}
