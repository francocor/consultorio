/**
 * Every word the shell shows outside the web app and its own pages: the tray, the dialogs, the notices.
 * Neutral, professional Spanish in the "usted" form, like the product. The product is "Consulvia".
 */
export const TEXT = {
  appName: 'Consulvia',

  splash: {
    starting: 'Iniciando Consulvia…',
    database: 'Preparando la base de datos…',
    restoring: 'Restaurando la copia de seguridad…',
  },

  tray: {
    tooltip: 'Consulvia',
    open: 'Abrir Consulvia',
    openInBrowser: 'Abrir en el navegador',
    outbox: 'Correos salientes',
    backup: 'Hacer copia de seguridad',
    restore: 'Restaurar copia…',
    resetPassword: 'Restablecer contraseña de la propietaria…',
    confirmRecoveryKey: 'Confirmar que guardó la clave de recuperación…',
    checkRecoveryKey: 'Comprobar la clave de recuperación…',
    tooltipRecoveryPending: 'Consulvia: falta confirmar que guardó la clave de recuperación',
    logs: 'Ver registros',
    autoStart: 'Iniciar con Windows',
    about: 'Acerca de',
    quit: 'Salir',
  },

  hint: {
    title: 'Consulvia sigue funcionando',
    body: 'Cerrar la ventana no cierra Consulvia: sigue activo junto al reloj de Windows para que las agendas y los recordatorios continúen. Para cerrarlo por completo, use el icono y elija Salir.',
  },

  backup: {
    done: 'Copia de seguridad lista',
    doneBody: (path: string) => `La copia se guardó en:\n${path}`,
    failed: 'No se pudo hacer la copia de seguridad',
    failedBody:
      'La copia no se completó. Sus datos no se modificaron. Si el problema continúa, abra los registros y envíe el archivo a quien le brinda soporte.',
    dailyFailed:
      'No se pudo hacer la copia de seguridad diaria. Abra Consulvia e intente hacerla manualmente.',
    notReady: 'Consulvia todavía se está iniciando. Espere unos segundos e intente de nuevo.',
    last: (when: string) => 'Última copia: ' + when,
    none: 'Última copia: todavía no hay ninguna',
    cloudTitle: 'Las copias están en una carpeta sincronizada',
    cloud:
      'La carpeta de copias de seguridad está dentro de una carpeta que se sincroniza con internet (OneDrive u otra). Las copias están cifradas, así que el servicio no puede leerlas, y esto sirve además como copia fuera de la computadora. Dos cuidados: deje la carpeta Copias marcada como "Mantener siempre en este dispositivo", para poder restaurar sin internet, y no dé por hecho que una copia ya llegó a la nube hasta que el servicio lo indique.',
    copyReminderTitle: 'Copia de seguridad fuera de la computadora',
    copyReminder:
      'Recuerde copiar la carpeta Documentos\\Consulvia\\Copias a un pendrive o a un disco externo y guardarlo fuera del consultorio. Una copia que está solo en esta computadora se pierde con ella.',
    diskFull:
      'El disco está lleno. Libere espacio en la unidad donde se guardan las copias y vuelva a intentar. Una copia necesita aproximadamente el doble de lo que ocupan los datos.',
    diskNeeds: (neededGb: string, freeGb: string) =>
      `Se necesitan unos ${neededGb} GB libres y hay ${freeGb} GB.`,
  },

  restore: {
    pickTitle: 'Elija la copia de seguridad que desea restaurar',
    pickFilter: 'Copias de Consulvia',
    confirmTitle: 'Restaurar copia de seguridad',
    confirmMessage: 'Se reemplazarán TODOS los datos actuales por los de la copia.',
    confirmDetail: (when: string) =>
      `Copia del ${when}. Antes de reemplazar nada, Consulvia hace una copia de seguridad de los datos actuales. Durante la restauración Consulvia queda sin servicio unos minutos.`,
    confirmButton: 'Restaurar',
    cancelButton: 'Cancelar',
    done: 'Copia restaurada',
    doneBody: 'Los datos de la copia ya están en uso.',
    failed: 'No se pudo restaurar la copia',
    invalid: 'El archivo elegido no es una copia de seguridad de Consulvia.',
    tampered:
      'La copia de seguridad está dañada, se modificó o se hizo con otra clave. No se leyó nada de ella y los datos actuales no se modificaron.',
    newerVersion:
      'Esta copia se hizo con una versión más nueva de Consulvia. Instale la versión más reciente e intente de nuevo.',
    wrongKey: 'La clave de recuperación no es correcta.',
    incomplete:
      'Los datos de la copia ya están en uso, pero Consulvia no pudo volver a iniciar todos sus servicios. No se deshizo nada. Cierre Consulvia con Salir en el icono y ábralo de nuevo; si el problema continúa, abra los registros.',
    diskFull:
      'No hay espacio suficiente en el disco para restaurar la copia. Libere espacio (se necesita aproximadamente el triple de lo que ocupan los datos) y vuelva a intentar. No se cambió nada.',
    generic:
      'La restauración no se completó. Los datos actuales se conservan. Si el problema continúa, abra los registros y envíe el archivo a quien le brinda soporte.',
  },

  reset: {
    windowTitle: 'Consulvia: restablecer contraseña',
    noOwner: 'No se encontró la cuenta de la propietaria.',
    generic: 'No se pudo restablecer la contraseña. Intente de nuevo.',
    notReady: 'Consulvia todavía se está iniciando. Espere unos segundos e intente de nuevo.',
    confirmTitle: 'Restablecer contraseña',
    confirmMessage: 'Va a restablecer la contraseña de la propietaria del consultorio.',
    confirmDetail:
      'Se cerrarán todas sus sesiones y se le avisará por correo. Para continuar hace falta la clave de recuperación que se mostró al configurar Consulvia.',
    confirmButton: 'Continuar',
    cancelButton: 'Cancelar',
    wrongKey: 'La clave de recuperación no es correcta.',
    tooManyAttempts:
      'Se superó el número de intentos. Cierre esta ventana y vuelva a empezar desde el icono de Consulvia.',
  },

  startOver: {
    confirmTitle: 'Empezar de nuevo',
    confirmMessage:
      'Consulvia va a apartar los datos actuales y empezar con una instalación vacía, para que usted restaure una copia de seguridad.',
    confirmDetail: (stamp: string) =>
      `Nada se borra: la configuración, la base de datos y los documentos actuales se mueven a carpetas con el sufijo "aside-${stamp}" dentro de la carpeta de datos de Consulvia. Va a necesitar el archivo de la copia y la clave de recuperación de aquella instalación.`,
    confirmButton: 'Apartar y empezar de nuevo',
    cancelButton: 'Cancelar',
    failed:
      'No se pudieron apartar los datos actuales (puede que otro programa los esté usando). No se cambió nada.',
  },

  orphaned: {
    title: 'Se apartaron datos sin configuración',
    body: (folders: string[]) =>
      `Consulvia encontró datos de una instalación anterior sin su archivo de configuración, que es lo único que permite leerlos, y empezó una instalación nueva. Los datos anteriores no se borraron: están en\n${folders.join('\n')}\nSi tiene una copia de seguridad, puede restaurarla desde el icono de Consulvia.`,
  },

  port: {
    movedTitle: 'La dirección local de Consulvia cambió',
    moved: (from: number, to: number) =>
      `El puerto ${String(from)} lo estaba usando otro programa, y Consulvia ahora usa el ${String(to)}. Los enlaces de los correos enviados antes (restablecer contraseña, invitaciones) dejaron de funcionar: vuelva a pedirlos.`,
  },

  recoveryKey: {
    windowTitle: 'Consulvia: clave de recuperación',
    checkWindowTitle: 'Consulvia: comprobar la clave de recuperación',
    gone: 'La clave de recuperación ya se confirmó y Consulvia no la vuelve a mostrar, para que nadie que use esta computadora pueda verla. Si la tiene anotada, puede comprobarla desde el icono de Consulvia.',
    wrongLast4:
      'No coincide con el final de la clave. Revise la clave y vuelva a escribir los últimos 4 caracteres.',
    wrong: 'No es la clave de recuperación de esta instalación.',
    tooManyAttempts:
      'Se superó el número de intentos. Cierre esta ventana y vuelva a empezar desde el icono de Consulvia.',
    reminderTitle: 'Falta confirmar la clave de recuperación',
    reminder:
      'Todavía no confirmó que guardó la clave de recuperación. Sin ella no se puede abrir una copia de seguridad en otra computadora. Abra el icono de Consulvia, junto al reloj de Windows, y elija "Confirmar que guardó la clave de recuperación".',
  },

  about: {
    title: 'Acerca de Consulvia',
    detail: (version: string, dataDir: string, backupsDir: string, lastBackup: string) =>
      `Versión ${version}\n\nLos datos están en:\n${dataDir}\n\nLas copias de seguridad están en:\n${backupsDir}\n\n${lastBackup}`,
    ok: 'Aceptar',
  },

  errors: {
    title: 'Consulvia no pudo iniciar',
    retry: 'Reintentar',
    logs: 'Ver registros',
    quit: 'Salir',
    startOver: 'Empezar de nuevo y restaurar una copia',
    cannotDecrypt:
      'No se pueden leer los datos de esta instalación con la cuenta de Windows actual. Los datos se protegen con la cuenta de Windows que instaló Consulvia: ingrese con esa cuenta. Si ya no es posible, puede empezar de nuevo y restaurar una copia de seguridad (sus datos actuales no se borran).',
    cipherUnavailable:
      'Windows no pudo proteger los datos de Consulvia en este momento. Cierre la sesión de Windows, vuelva a ingresar e intente de nuevo.',
    configUnreadable:
      'El archivo de configuración de Consulvia está dañado y no hay una copia anterior que se pueda leer. Puede empezar de nuevo y restaurar una copia de seguridad (sus datos actuales no se borran). Volver a instalar Consulvia no lo arregla.',
    dataMissing:
      'Falta la carpeta de la base de datos de esta instalación. Si se movió o se borró, puede empezar de nuevo y restaurar una copia de seguridad.',
    missingFiles: 'La instalación está incompleta. Vuelva a instalar Consulvia.',
    database:
      'No se pudo iniciar la base de datos. Si la computadora se apagó de golpe, espere un minuto e intente de nuevo.',
    portBusy: 'No se pudo abrir el puerto local de Consulvia.',
    service:
      'Un componente de Consulvia no pudo iniciar o se detuvo varias veces seguidas. Abra los registros para ver el detalle.',
    generic:
      'Ocurrió un error inesperado al iniciar Consulvia. Abra los registros para ver el detalle.',
    migration:
      'No se pudieron aplicar las actualizaciones de la base de datos. Sus datos no se modificaron. Abra los registros para ver el detalle.',
  },

  setup: {
    failed: 'No se pudo crear el consultorio. Intente de nuevo.',
    emailInUse: 'Ese correo electrónico ya está en uso.',
    alreadyDone: 'Consulvia ya estaba configurado en esta computadora.',
    busy: 'Ya se está preparando el consultorio. Espere unos segundos.',
  },
} as const;
