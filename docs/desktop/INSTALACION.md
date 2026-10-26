# Consulvia para Windows: guía de instalación

Esta guía es para el consultorio que usa Consulvia en una sola computadora. No hace falta conocimiento técnico.

## Qué es

Consulvia es el sistema de gestión del consultorio: agenda, pacientes, historia clínica, documentos, facturación y recordatorios. La versión para Windows funciona completa en **una computadora**, sin internet y sin contratar ningún servicio: los datos quedan en esa computadora y en las copias de seguridad que usted guarde.

## Qué necesita

| Requisito           | Detalle                                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sistema operativo   | Windows 10 o Windows 11, de 64 bits                                                                                                                               |
| Memoria             | 4 GB como mínimo, 8 GB recomendados                                                                                                                               |
| Espacio en disco    | 1,5 GB libres para instalar el programa, más el espacio de sus datos y de las copias de seguridad (cada copia pesa lo mismo que los datos: planifique algunos GB) |
| Permisos            | Un usuario común de Windows alcanza. **No** se piden permisos de administrador                                                                                    |
| Internet            | No es necesario para usar Consulvia                                                                                                                               |
| Instalador firmado? | Todavía no. Ver el aviso de Windows más abajo                                                                                                                     |

## Instalar

1. Haga doble clic en **`Consulvia-Setup-<versión>.exe`**.
2. Si Windows muestra _"Windows protegió su PC"_, el instalador todavía no está firmado digitalmente. Elija **Más información** y después **Ejecutar de todas formas**. Haga esto solo con un instalador que le entregó quien le brinda el servicio.
3. La instalación es de un solo paso, sin preguntas. Al terminar se crea un acceso directo **Consulvia** en el escritorio y en el menú Inicio, y Consulvia se abre sola.

El programa se instala para el usuario de Windows que lo instala, en `%LOCALAPPDATA%\Programs\Consulvia`. Para actualizar, ejecute el instalador de la versión nueva: sus datos se conservan. Si Consulvia está abierto, el instalador le pide que se cierre por sí mismo (como **Salir**) y espera a que termine antes de reemplazar archivos; no lo cierre desde el Administrador de tareas. Cuando la versión nueva trae cambios en la base de datos, Consulvia hace antes una **copia de seguridad previa a la actualización** (`consulvia-previa-actualizacion-…`) y no actualiza si esa copia no se pudo hacer. Sirve como copia previa cualquier copia verificada de las últimas 24 horas, así que lo habitual es que no haga otra. Si la copia falla y al reintentar vuelve a fallar, Consulvia ofrece **Continuar sin esta copia**, con una advertencia: úselo solo si no queda otra salida, y haga una copia manual apenas pueda. **Para volver a la versión anterior** no alcanza con reinstalarla: una versión anterior se niega a abrir una base de datos ya actualizada. Reinstale la versión anterior: Consulvia dirá que los datos son de una versión más nueva y, después de tres intentos, ofrecerá **Empezar de nuevo y restaurar una copia**. Elíjalo y restaure la copia previa a la actualización (o la última copia buena); los datos de después de esa copia se pierden. Una versión **anterior** a la que creó los datos se niega a abrirlos: instale la versión más reciente.

## Primer inicio

La primera vez, Consulvia prepara la base de datos. Tarda uno o dos minutos y muestra _"Iniciando Consulvia…"_. Después aparece la pantalla **Bienvenido a Consulvia**:

1. Escriba el **nombre del consultorio**, su **nombre y apellido**, su **correo electrónico** (con él va a ingresar) y la **zona horaria**.
2. Elija una **contraseña** de al menos 12 caracteres. Una frase larga es una buena opción. Consulvia rechaza las contraseñas muy comunes.
3. Pulse **Continuar**. Todavía no se crea nada: primero se muestra la clave de recuperación.
4. Se muestra la **clave de recuperación**: 30 letras y números en grupos de cinco. **Imprímala o anótela y guárdela en un lugar seguro: es la única vez que Consulvia la muestra.** Sirve para abrir una copia de seguridad en otra computadora y para restablecer la contraseña de la propietaria.
5. **Escriba los últimos 4 caracteres de la clave** y pulse **La guardé: crear mi consultorio**. Es la forma de confirmar que la leyó y la anotó, y recién entonces Consulvia crea el consultorio (espere unos segundos). **Consulvia no guarda la clave en esta computadora en ningún momento** (se conserva solo una huella que permite comprobarla): así nadie que use la computadora puede verla.
6. Pulse **Abrir Consulvia** e ingrese con su correo y su contraseña.

Si cierra la ventana, o se corta la luz, antes de confirmar la clave, **no queda nada a medias**: el consultorio no se creó, y al abrir Consulvia de nuevo empieza otra vez, con una clave nueva. Si no puede crear el consultorio (por ejemplo, la contraseña no es aceptada), Consulvia vuelve al formulario con el motivo.

Si la clave se pierde, no se puede recuperar desde el programa. Para una instalación que nunca llegó a confirmar su clave (solo las de una versión de prueba anterior), el icono junto al reloj ofrece _Generar una nueva clave de recuperación…_: pide el **correo, la contraseña y, si la tiene, el código de verificación en dos pasos de la propietaria**, comprobados por el propio servicio de Consulvia (no basta con tener la sesión de Windows abierta); muestra la clave nueva una sola vez y la deja en vigor cuando se confirma con los últimos 4 caracteres. La clave anterior deja de servir; las copias hechas antes siguen abriéndose en esta computadora, y en otra solo con la clave con que se hicieron. Una instalación que ya confirmó su clave no la puede cambiar: eso permitiría a cualquiera que use la computadora tomar la cuenta de la propietaria.

Esa cuenta es la de la **propietaria** del consultorio. Desde Configuración puede invitar a más personas (profesionales, recepción).

## Uso diario

- Consulvia queda activo junto al reloj de Windows (el icono de Consulvia, a veces dentro de la flecha ^). **Cerrar la ventana no cierra Consulvia**: sigue funcionando para que los recordatorios continúen. Para cerrarlo por completo, haga clic derecho en el icono y elija **Salir**.
- _Abrir en el navegador_ abre el mismo Consulvia en Chrome, Edge u otro navegador de esta computadora.
- _Iniciar con Windows_ hace que Consulvia arranque solo al encender la computadora. Está desactivado hasta que usted lo marque.
- Apague la computadora después de **Salir**, o con el apagado normal de Windows. No la apague desenchufándola: aunque Consulvia se recupera, es mejor evitarlo.

El menú del icono tiene:

| Opción                                    | Qué hace                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| Abrir Consulvia                           | Muestra la ventana                                                                         |
| Abrir en el navegador                     | Abre Consulvia en su navegador                                                             |
| Correos salientes                         | Abre la carpeta con los correos que Consulvia generó (ver más abajo)                       |
| Hacer copia de seguridad                  | Hace una copia ahora                                                                       |
| Restaurar copia…                          | Reemplaza los datos por los de una copia                                                   |
| Restablecer contraseña de la propietaria… | Para cuando la propietaria olvidó su contraseña                                            |
| Confirmar que guardó la clave…            | Mientras no se confirmó: muestra la clave y pide confirmarla                               |
| Comprobar la clave de recuperación…       | Dice si la clave que usted escribe es la correcta (y, si faltaba confirmarla, la confirma) |
| Ver registros                             | Abre la carpeta con los registros (para enviar a soporte)                                  |
| Iniciar con Windows                       | Marca o desmarca el inicio automático                                                      |
| Acerca de                                 | Versión y ubicación de los datos                                                           |
| Salir                                     | Cierra Consulvia por completo                                                              |

## Copias de seguridad

- Consulvia hace **una copia automática por día**, la primera vez que se abre cada día. Conserva las **últimas 14 copias automáticas** y las **últimas 14 manuales** (se cuentan por separado), y nunca menos de 7 de cada tipo. Las copias de seguridad previas a una restauración se limitan a las últimas 3.
- **Cada copia se comprueba apenas se escribe:** Consulvia la vuelve a abrir, verifica que no esté dañada y que el programa que la restaura pueda leerla. Una copia que no pasa esa comprobación se descarta y Consulvia avisa; nunca se borra una copia buena para hacer lugar a una que no se comprobó. En la carpeta de copias queda el archivo `registro-de-copias.json`, con la lista de las que se comprobaron: no lo borre ni lo edite.
- **Si el disco está lleno**, Consulvia lo avisa antes de empezar (una copia necesita aproximadamente el doble de lo que ocupan los datos libre en la unidad de `Documentos`). Libere espacio y vuelva a intentar.
- Para hacer una copia en cualquier momento: icono de Consulvia, **Hacer copia de seguridad**.
- **Cuándo fue la última copia buena** se ve en el menú del icono (_Última copia: …_) y en **Acerca de**. Solo cuenta una copia que pasó su comprobación. Si la copia del día falla, Consulvia avisa y la intenta de nuevo a los 5 minutos, y después a los 10, 20, 40 y cada hora hasta que sale.
- Si `Documentos` está dentro de **OneDrive** (o de otro servicio que sincroniza carpetas), Consulvia lo avisa una vez. Las copias están cifradas, de modo que el servicio no puede leerlas, y además sirven como copia fuera de la computadora; deje la carpeta `Copias` marcada como _Mantener siempre en este dispositivo_ para poder restaurar sin internet.
- Las copias están en **`Documentos\Consulvia\Copias`**, con el nombre `consulvia-diaria-AAAA-MM-DD_HHMM.cvb` (o `consulvia-manual-…`). Cada una es **un solo archivo cifrado y autenticado**: incluye la base de datos y todos los documentos de los pacientes, y no se puede leer ni modificar sin la clave de esta instalación. Consulvia se niega a restaurar un archivo que se modificó, se cortó o no corresponde a esta instalación, y no lee nada de él.
- Consulvia se lo recuerda **cada 30 días** con un aviso, porque no puede saber si usted ya copió la carpeta a otro lugar.
- **Una copia en la misma computadora no protege de un robo, un incendio o un disco roto.** Una vez por semana, copie la carpeta `Copias` a un pendrive, a un disco externo o a un servicio de almacenamiento de su confianza, y guárdelo fuera del consultorio. Las copias contienen datos de salud: trátelas con el mismo cuidado que la historia clínica en papel.

## Restaurar una copia

1. Icono de Consulvia, **Restaurar copia…**, y elija el archivo `.cvb`.
2. Consulvia le muestra de qué fecha y de qué tipo es la copia y si es **de esta instalación o de otra**, y pide confirmación. Después pide la **clave de recuperación de esta instalación**: restaurar reemplaza todos los datos, y sin esa clave cualquiera que tuviera abierta la sesión de Windows podría restaurar una copia hecha a su medida y quedarse con el consultorio. Con 5 claves erróneas la ventana se cierra. Si la copia es de otra instalación hacen falta **las dos claves**.
3. Consulvia hace **una copia de seguridad de los datos actuales** (`consulvia-previa-restauracion-…`) y recién entonces reemplaza todo. Durante unos minutos Consulvia queda sin servicio.
4. Cuando termina, Consulvia se abre con los datos de la copia.

Una instalación nueva que todavía no se configuró no tiene nada que proteger: ahí no se pide la clave de esta instalación (solo la de la copia, si es de otra).

Antes de tocar nada, Consulvia comprueba que el archivo no esté dañado ni alterado y que haya lugar en el disco (se necesita aproximadamente el triple de lo que ocupan los datos). Si algo falla en el medio, los datos actuales se conservan. **Si la computadora se apaga o Consulvia se cierra a la mitad de una restauración**, al abrirlo de nuevo Consulvia la termina o la deshace sola, según hasta dónde llegó, y no queda una instalación a medias. Si la restauración termina bien pero Consulvia no logra volver a iniciar algún servicio, avisa que los datos de la copia ya están en uso (no se deshace nada): cierre Consulvia con **Salir** y ábralo de nuevo.

**En otra computadora** (por ejemplo, si la primera se rompió): instale Consulvia y, **sin completar la pantalla de bienvenida**, abra el icono de Consulvia junto al reloj de Windows y elija **Restaurar copia…** con el archivo de la copia. Como esa copia es de otra instalación, Consulvia pide la **clave de recuperación** que se mostró en la primera computadora. Sin esa clave la copia no se puede abrir en otra computadora: por eso conviene guardarla impresa. Al terminar, esa clave pasa a ser la de la nueva instalación, y las copias nuevas que haga se abren con ella. En la misma computadora no hace falta escribirla.

Si la copia es de una versión de Consulvia más nueva que la instalada, Consulvia lo avisa y no restaura: instale primero la versión más reciente.

## Olvidé la contraseña

- **De la propietaria:** en esta computadora, icono de Consulvia, **Restablecer contraseña de la propietaria…**. Consulvia pide confirmar y luego la **clave de recuperación** (la de la primera pantalla): quien solo tiene abierta la sesión de Windows no puede cambiar la contraseña. Después escriba la contraseña nueva dos veces. Con 5 claves erróneas la ventana se cierra y hay que empezar de nuevo. Si perdió también el teléfono de la verificación en dos pasos, marque **Quitar también la verificación en dos pasos**; la propietaria podrá volver a activarla desde su cuenta. Se cierran las sesiones abiertas de esa cuenta, queda registrado en el historial de auditoría como un cambio hecho desde la computadora (no como si lo hubiera hecho la propietaria) y se deja un aviso para la propietaria en **Correos salientes**.
- **De otra persona:** en la pantalla de ingreso use _¿Olvidó su contraseña?_. Como esta instalación no tiene servidor de correo, el mensaje no sale por internet: queda guardado en **Correos salientes** (icono de Consulvia). Abra el archivo `.eml` más reciente con su programa de correo, o abra el `.json` que lo acompaña, y copie el enlace a la persona. Los correos con más de 60 días se borran solos.

## Dónde están los datos

| Qué                               | Dónde                                       |
| --------------------------------- | ------------------------------------------- |
| Base de datos                     | `%LOCALAPPDATA%\Consulvia\pgdata`           |
| Documentos de los pacientes       | `%LOCALAPPDATA%\Consulvia\files`            |
| Claves y configuración (cifradas) | `%LOCALAPPDATA%\Consulvia\config.json`      |
| Correos salientes                 | `%LOCALAPPDATA%\Consulvia\outbox`           |
| Perfil de la ventana              | `%LOCALAPPDATA%\Consulvia\electron-profile` |
| Registros                         | `%LOCALAPPDATA%\Consulvia\logs`             |
| Copias de seguridad               | `Documentos\Consulvia\Copias`               |
| Programa                          | `%LOCALAPPDATA%\Programs\Consulvia`         |

`%LOCALAPPDATA%` es normalmente `C:\Users\<usuario>\AppData\Local`, una carpeta que no se sincroniza con otras computadoras. **No mueva, renombre ni borre estas carpetas con Consulvia abierto.** **Nunca borre `electron-profile`:** contiene la llave de Windows que protege las claves de `config.json`; sin ella, los datos de esta instalación no se pueden abrir y solo queda restaurar una copia de seguridad. Las claves de `config.json` están protegidas con la cuenta de Windows. Si se crea otro usuario de Windows en la computadora, instale y use Consulvia siempre con el mismo.

## Qué protege Consulvia y qué le corresponde a usted

- **Las copias de seguridad** están cifradas y autenticadas por Consulvia: sin la clave de la instalación no se pueden leer ni modificar, y Consulvia no restaura una que haya sido alterada.
- **La base de datos y los documentos que están en la computadora NO están cifrados por Consulvia.** Cualquier persona con acceso al disco (una computadora robada, un administrador de Windows, quien arranque desde otro sistema) puede leerlos. Para esta versión de una sola computadora eso se resuelve cifrando el disco de Windows: active **BitLocker** (Windows 10/11 Pro) o el **cifrado de dispositivo** (Windows 11 Home), y use una contraseña de Windows que solo conozca el personal autorizado. **Se recomienda hacerlo antes de cargar datos reales.**
- **Quién usa la sesión de Windows:** quien tenga abierta la sesión de Windows de esta computadora puede abrir Consulvia. Para cambiar la contraseña de la propietaria se pide la clave de recuperación, que solo debe tener la propietaria y que Consulvia no guarda a la vista en la computadora.

## Desinstalar

Configuración de Windows, Aplicaciones, **Consulvia**, Desinstalar. Se elimina el programa y los accesos directos. **Los datos y las copias de seguridad se conservan** (`%LOCALAPPDATA%\Consulvia` y `Documentos\Consulvia\Copias`), de modo que reinstalar Consulvia los recupera. Para eliminar los datos por completo hay que borrar esas dos carpetas a mano; no se puede deshacer.

## Qué no incluye esta versión

- **Recetas electrónicas:** la verificación de matrícula depende de la consola del operador de la plataforma, que no existe en la versión de una sola computadora. Las recetas están desactivadas.
- **Facturación electrónica con AFIP:** las facturas se pueden preparar en Consulvia, pero la conexión real con AFIP todavía no está disponible.
- **Turnos online, portal del paciente y lista de espera fuera de la computadora:** los enlaces solo funcionan desde esta misma computadora. Los pacientes no pueden reservar desde su casa.
- **Videoconsulta, WhatsApp y cobros online:** desactivados. Los recordatorios y avisos por correo no salen por internet (ver _Correos salientes_).
- **Varias computadoras:** esta versión es para una sola. No se sincroniza entre equipos.

## Si algo no funciona

- Si la base de datos deja de responder mientras Consulvia está abierto (por ejemplo, un antivirus la cerró), Consulvia lo nota en menos de un minuto y la vuelve a iniciar sola, junto con el resto de sus servicios. Si un servicio se detiene varias veces seguidas, aparece el mismo aviso con el botón **Reintentar**, que lo vuelve a iniciar sin cerrar Consulvia. Si pulsó **Reintentar** después de un inicio muy lento, Consulvia espera a la base de datos que todavía está arrancando en lugar de detenerla.
- _"Consulvia no pudo iniciar"_: pulse **Reintentar**. Si se repite, elija **Ver registros** y envíe la carpeta `logs` a quien le brinda soporte.
- **Los registros pueden contener datos de pacientes.** Consulvia quita de ellos las direcciones de correo y las contraseñas y pide a la base de datos que no escriba el texto de las consultas, pero un error del programa puede nombrar a una persona. Envíe la carpeta `logs` solo a quien usted ya confía sus datos, nunca la publique. Los registros se limitan solos: cada archivo llega a 5 MB y se guardan los últimos tres.
- _"No se pueden leer los datos de esta instalación con la cuenta de Windows actual"_: está ingresando con otro usuario de Windows. Cierre la sesión e ingrese con el usuario que instaló Consulvia.
- _"El archivo de configuración está dañado"_, _"Falta la carpeta de la base de datos"_ o el mensaje anterior sin salida: elija **Empezar de nuevo y restaurar una copia**. Consulvia **aparta** (no borra) la configuración, la base de datos y los documentos actuales en carpetas con el sufijo `.aside-<número>`, empieza una instalación vacía y le pide el archivo de la copia (`.cvb`) y, si es de otra instalación, la clave de recuperación. Los datos apartados se conservan hasta que usted los borre: están en la carpeta de datos de Consulvia (el aviso de confirmación dice el sufijo exacto) y **conservan los datos de los pacientes sin cifrar**, así que bórrelas a mano cuando haya comprobado que la copia restaurada está completa. Esta opción se ofrece sola cuando los datos no se pueden abrir, o cuando el **mismo** error se repite tres inicios seguidos; si los tres errores fueron distintos, queda detrás de **Más opciones…**. Un registro de restauración que quedó a medias (`restore-journal.json`) y lo que nombra se apartan también. **Deshacer "Empezar de nuevo":** cierre Consulvia (icono junto al reloj, **Salir**); en `%LOCALAPPDATA%\Consulvia` agregue `.nueva` al nombre de `config.json`, `pgdata` y `files` de la instalación vacía, y a cada carpeta o archivo `…aside-<número>` quítele esa terminación (`config.json.aside-123` vuelve a ser `config.json`); abra Consulvia de nuevo.
- _"Se apartaron datos sin configuración"_: Consulvia encontró la base de datos sin su `config.json` (ni su copia `config.json.bak`), y sin él no se pueden leer. Los datos no se borraron: están en las carpetas `.orphaned-<número>` que el aviso indica. Restaure una copia de seguridad desde el icono de Consulvia.
- El antivirus puede demorar el primer inicio o el programa de base de datos. Si bloquea Consulvia, agregue la carpeta del programa y `%LOCALAPPDATA%\Consulvia` a las excepciones.
- Si la computadora se apagó de golpe y Consulvia tarda en abrir, espere un minuto: la base de datos se recupera sola.
