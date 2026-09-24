/**
 * Minimal shape of a Gmail API message as returned by
 * `users.messages.get?format=metadata`. Only the fields Clearbox actually
 * reads are modeled here.
 *
 * https://developers.google.com/gmail/api/reference/rest/v1/users.messages
 */
export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailMessagePayload {
  headers?: GmailHeader[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  /** Milliseconds since the epoch, as a decimal string (per the Gmail API). */
  internalDate: string;
  sizeEstimate: number;
  payload?: GmailMessagePayload;
}
