export type BoardErrorCode =
  | 'TASK_NOT_FOUND'
  | 'COLUMN_NOT_FOUND'
  | 'DUPLICATE_COLUMN'
  | 'INVALID_COLUMNS'
  | 'DUPLICATE_PROJECT'
  | 'INVALID_PROJECTS'
  | 'INVALID_PROJECT'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_NOT_EMPTY'
  | 'INVALID_TITLE'
  | 'INVALID_DESCRIPTION'
  | 'INVALID_ASSIGNEE'
  | 'INVALID_PRIORITY'
  | 'CONFLICT'
  | 'BOARD_LOCKED'
  | 'INVALID_BOARD_FILE'
  | 'INVALID_ATTACHMENT'
  | 'ATTACHMENT_NOT_FOUND'
  | 'ATTACHMENT_TOO_LARGE'
  | 'ATTACHMENT_LIMIT';

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
