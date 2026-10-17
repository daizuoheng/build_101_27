/** UUID canónico (8-4-4-4-12). Un id con otra forma no llega a la base: un cast fallido a uuid sería un 500. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (s: string): boolean => UUID.test(s);
