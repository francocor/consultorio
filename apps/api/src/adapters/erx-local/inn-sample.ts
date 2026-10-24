/**
 * A small sample of generic names (international nonproprietary names, in Spanish), enough for the
 * local e-prescription simulator to behave like a provider that validates the medication against a
 * catalog, and for the form of a prescription to suggest names while the professional types. The
 * real catalog is the one of the authorized platform (the deferred adapter, S5.D); this one only
 * says which names the simulator accepts.
 */
export const INN_SAMPLE: readonly string[] = [
  'Acenocumarol',
  'Aciclovir',
  'Ácido acetilsalicílico',
  'Ácido fólico',
  'Alprazolam',
  'Amiodarona',
  'Amlodipina',
  'Amoxicilina',
  'Amoxicilina con ácido clavulánico',
  'Atenolol',
  'Atorvastatina',
  'Azitromicina',
  'Bisoprolol',
  'Budesonida',
  'Captopril',
  'Carbamazepina',
  'Carvedilol',
  'Cefalexina',
  'Ceftriaxona',
  'Cetirizina',
  'Ciprofloxacina',
  'Claritromicina',
  'Clonazepam',
  'Clopidogrel',
  'Dexametasona',
  'Diazepam',
  'Diclofenac',
  'Digoxina',
  'Enalapril',
  'Escitalopram',
  'Espironolactona',
  'Fluconazol',
  'Fluoxetina',
  'Furosemida',
  'Gentamicina',
  'Glibenclamida',
  'Hidroclorotiazida',
  'Ibuprofeno',
  'Insulina glargina',
  'Ketorolac',
  'Lamotrigina',
  'Levofloxacina',
  'Levotiroxina',
  'Loratadina',
  'Losartán',
  'Meloxicam',
  'Metformina',
  'Metoclopramida',
  'Metotrexato',
  'Metronidazol',
  'Naproxeno',
  'Nifedipina',
  'Nitrofurantoína',
  'Omeprazol',
  'Ondansetrón',
  'Pantoprazol',
  'Paracetamol',
  'Prednisona',
  'Propranolol',
  'Ranitidina',
  'Rosuvastatina',
  'Salbutamol',
  'Sertralina',
  'Simvastatina',
  'Tramadol',
  'Trimetoprima con sulfametoxazol',
  'Valsartán',
  'Warfarina',
];

/** Lower case without accents, so "Losartan" finds "Losartán". */
export function foldName(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

const FOLDED = INN_SAMPLE.map((name) => ({ name, folded: foldName(name) }));

/** The names that start with what is typed (accents and case do not matter), at most `limit`. */
export function searchGenericNames(query: string, limit: number): readonly string[] {
  const typed = foldName(query);
  const found =
    typed === ''
      ? FOLDED
      : FOLDED.filter(
          (entry) =>
            entry.folded.startsWith(typed) ||
            entry.folded.split(' ').some((word) => word.length > 3 && word.startsWith(typed)),
        );
  return found.slice(0, limit).map((entry) => entry.name);
}

/**
 * Whether a prescription line starts with a name of the catalog. The longest name wins, so
 * "Amoxicilina con ácido clavulánico 500 mg" is recognised as itself and not only as "Amoxicilina".
 */
export function startsWithGenericName(line: string): boolean {
  const folded = foldName(line);
  return FOLDED.some(
    (entry) =>
      folded === entry.folded ||
      (folded.startsWith(entry.folded) && /[^a-z]/.test(folded.charAt(entry.folded.length))),
  );
}
