/**
 * Takes out of a line of `shell.log` what could identify a person or open the database. The log is what a
 * clinic sends to whoever supports it, and it gets the tails of the standard error of the API, of
 * PostgreSQL and of the commands, which can quote a row, an email address or a connection address.
 */
export function redact(text: string): string {
  return (
    text
      // postgres://user:password@host → the password goes.
      .replaceAll(/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, '$1***@')
      .replaceAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
      .replaceAll(/password\s*[=:]\s*\S+/gi, 'password=***')
      // `Key (document_number)=(20123456) already exists.`
      .replaceAll(/(Key \([^)]*\)=\()[^)]*\)/g, '$1***)')
  );
}
