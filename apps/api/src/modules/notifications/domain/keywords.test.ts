import { describe, expect, it } from 'vitest';

import { classifyReply } from './keywords.js';

describe('classifyReply', () => {
  it.each([
    'BAJA',
    'baja',
    ' Baja ',
    'BAJA.',
    'baja!',
    '"BAJA"',
    'STOP',
    'stop',
    'Stop.',
    '¡BAJA!',
    'PARAR',
    'parar.',
    'No más',
    'NO MAS',
    ' no   mas! ',
  ])('reads %j as an opt-out keyword', (text) => {
    expect(classifyReply(text)).toBe('opt_out');
  });

  it.each(['1', ' 1 ', '1.', '1!'])('reads %j as the fixed reply "confirm"', (text) => {
    expect(classifyReply(text)).toBe('confirm');
  });

  it.each(['2', ' 2 ', '2.'])('reads %j as the fixed reply "cancel"', (text) => {
    expect(classifyReply(text)).toBe('cancel');
  });

  it.each([
    'maybe tomorrow',
    'tal vez mañana',
    'SI',
    'sí',
    'ok',
    '12',
    '1 y 2',
    '3',
    '',
    'no quiero baja',
    'dar de baja',
    'BAJA por favor',
  ])('does not read %j as anything: a person looks at it', (text) => {
    expect(classifyReply(text)).toBe('other');
  });
});
