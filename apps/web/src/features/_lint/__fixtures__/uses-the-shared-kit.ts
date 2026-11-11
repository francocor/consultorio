// Fine: a feature may import the shared kit and the shell, and its own files.
import { useMe } from '../../../app/session.js';
import { cn } from '../../../shared/lib/cn.js';

export const probe = [cn, useMe];
