/**
 * Starter texts for consent templates, in neutral Spanish (informed-consent, "Consent template
 * authoring": the system MAY provide starter templates per specialty). They are a place to begin,
 * not legal advice: the organization reads, adjusts and publishes its own. Nothing here names a
 * person; the patient and the professional are identified by the signed record, not by the text.
 */
export interface ConsentStarter {
  /** Stable identifier, stored on the template that was made from it. */
  key: string;
  /** The specialty key of the clinical templates (`general`, `odontology`, ...). */
  specialty: string;
  title: string;
  body: string;
}

const RIGHTS =
  'Entiendo que puedo hacer todas las preguntas que necesite antes de firmar y que recibí respuestas que comprendí. ' +
  'Mi decisión es voluntaria. Puedo revocar este consentimiento en cualquier momento, sin que ello afecte la calidad de mi atención; ' +
  'la revocación no deshace los actos ya realizados.';

export const CONSENT_STARTERS: readonly ConsentStarter[] = [
  {
    key: 'general_care',
    specialty: 'general',
    title: 'Consentimiento informado para la atención médica',
    body: [
      'Declaro que el profesional me explicó, en términos que comprendo, el motivo de la consulta, el estudio o el tratamiento propuesto, su objetivo y las alternativas posibles, incluida la de no realizarlo.',
      'Me informó los beneficios esperados y los riesgos y molestias más frecuentes, así como los poco frecuentes pero graves que puedan presentarse. También me informó qué cuidados debo tener y a quién debo consultar si aparece algún problema.',
      'Autorizo al equipo de salud a realizar el procedimiento indicado y a tomar las medidas necesarias si surge una situación imprevista que ponga en riesgo mi salud, dentro de lo que el criterio profesional aconseje.',
      'Mis datos personales y de salud serán tratados con confidencialidad y solo para mi atención, conforme a la normativa vigente.',
      RIGHTS,
    ].join('\n\n'),
  },
  {
    key: 'odontology_extraction',
    specialty: 'odontology',
    title: 'Consentimiento informado para extracción dental',
    body: [
      'Declaro que el profesional me explicó el diagnóstico, el motivo por el cual se indica la extracción de la pieza dental y las alternativas de tratamiento, incluida la de no extraerla.',
      'Me informó los riesgos propios de la extracción, entre ellos dolor, inflamación, sangrado, infección, alveolitis, lesión de piezas o tejidos vecinos, comunicación con el seno maxilar y alteraciones transitorias o, excepcionalmente, permanentes de la sensibilidad. Me explicó los riesgos de la anestesia local y las indicaciones que debo seguir antes y después del procedimiento.',
      'Informé al profesional mis enfermedades, medicación habitual, alergias y antecedentes de reacciones a anestésicos. Entiendo que ocultar o no informar estos datos puede aumentar los riesgos.',
      'Autorizo la extracción y el uso de anestesia local, así como las medidas que el profesional considere necesarias si surge una complicación durante el procedimiento.',
      RIGHTS,
    ].join('\n\n'),
  },
  {
    key: 'physiotherapy_treatment',
    specialty: 'physiotherapy',
    title: 'Consentimiento informado para tratamiento de kinesiología',
    body: [
      'Declaro que el profesional me explicó la evaluación realizada, el plan de tratamiento propuesto, sus objetivos, su duración estimada y las técnicas que puede incluir, como ejercicio terapéutico, terapia manual, electroterapia, agentes físicos o vendajes.',
      'Me informó los beneficios esperados y los riesgos y molestias posibles, entre ellos dolor o rigidez transitorios, fatiga, enrojecimiento o irritación de la piel, y la posible reaparición o aumento de los síntomas. Me indicó que debo avisar de inmediato si siento dolor intenso, mareos o cualquier malestar durante la sesión.',
      'Informé al profesional mis enfermedades, cirugías, medicación, alergias y cualquier condición que pueda limitar el tratamiento. Entiendo que puedo pedir que se modifique o se interrumpa una técnica en cualquier momento.',
      'Autorizo el tratamiento propuesto y el contacto físico necesario para realizarlo.',
      RIGHTS,
    ].join('\n\n'),
  },
  {
    key: 'nutrition_plan',
    specialty: 'nutrition',
    title: 'Consentimiento informado para atención nutricional',
    body: [
      'Declaro que el profesional me explicó la evaluación nutricional que se realizará, que puede incluir mediciones corporales, análisis de mis hábitos alimentarios y un plan de alimentación individual, y los objetivos que se buscan.',
      'Me informó los beneficios y los riesgos: los resultados dependen en buena medida de mi adherencia al plan, puede haber molestias digestivas o cambios en mi energía al modificar la alimentación y que debo consultar si aparece algún síntoma inesperado.',
      'Informé al profesional mis enfermedades, medicación, alergias e intolerancias alimentarias, y si estoy embarazada o en período de lactancia. Entiendo que el plan se ajustará según mi evolución y que no reemplaza la indicación de otros profesionales que me atienden.',
      'Autorizo la evaluación, la toma de mediciones y el seguimiento nutricional propuestos.',
      RIGHTS,
    ].join('\n\n'),
  },
  {
    key: 'psychology_treatment',
    specialty: 'psychology',
    title: 'Consentimiento informado para atención psicológica',
    body: [
      'Declaro que el profesional me explicó en qué consiste el proceso de atención psicológica, sus objetivos, la modalidad (presencial o virtual), la frecuencia y duración estimada de las sesiones y los honorarios acordados.',
      'Me informó los beneficios esperados y los riesgos del proceso: los resultados no pueden garantizarse, puede haber momentos de malestar emocional y puedo conversar con el profesional sobre cualquier duda o dificultad que surja.',
      'Entiendo que lo que converse en las sesiones es confidencial y está protegido por el secreto profesional. Me informó los límites de esa confidencialidad: situaciones de riesgo grave para mi vida o la de otras personas, y los casos en que la ley o una orden judicial exijan revelar información.',
      'Autorizo el inicio de la atención psicológica y el registro de la información necesaria en mi historia clínica.',
      RIGHTS,
    ].join('\n\n'),
  },
];

export function findStarter(key: string): ConsentStarter | undefined {
  return CONSENT_STARTERS.find((starter) => starter.key === key);
}
