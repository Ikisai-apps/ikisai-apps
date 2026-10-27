-- Ikisai Booking · primer estimado de utilidad de sus funcionalidades (decisión de VG del 27-10-2026; núcleo 0113,
-- `core.usage_estimate`). Para cada funcionalidad, la frecuencia y la audiencia esperadas, para que Dirección decida en
-- Central. Solo se aplica mientras Dirección no haya decidido, y vale también para ids que todavía no estén en el catálogo.
-- La fuente es docs/booking/USO_ESTIMADO.json (con el porqué de cada uno); esta lista se genera desde ahí, y
-- tests/booking/usage-estimate.test.ts comprueba que coinciden.
-- Toca solo el schema booking (la función es del núcleo; el dato, de Booking).

select core.usage_estimate('booking', $uso$[
 {
  "id": "booking.inicio.proximas",
  "frequency": "frequent",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina",
    "recepcion",
    "direccion"
   ]
  }
 },
 {
  "id": "booking.inicio.avisos",
  "frequency": "frequent",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina",
    "direccion"
   ]
  }
 },
 {
  "id": "booking.inicio.cifras",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "direccion"
   ]
  }
 },
 {
  "id": "booking.inicio.sincronizacion",
  "frequency": "rare_critical",
  "audience": {
   "kinds": [
    "staff"
   ]
  }
 },
 {
  "id": "booking.inicio.instalar",
  "frequency": "occasional",
  "audience": {
   "kinds": [
    "staff"
   ]
  }
 },
 {
  "id": "booking.inicio.utilidades",
  "frequency": "occasional",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina"
   ]
  }
 },
 {
  "id": "booking.reservas.lista",
  "frequency": "frequent",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina",
    "comercial"
   ]
  }
 },
 {
  "id": "booking.reservas.buscador",
  "frequency": "frequent",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina",
    "comercial"
   ]
  }
 },
 {
  "id": "booking.reservas.filtros",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina",
    "comercial"
   ]
  }
 },
 {
  "id": "booking.reservas.alta",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "comercial",
    "oficina"
   ]
  }
 },
 {
  "id": "booking.reservas.nueva",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "comercial",
    "oficina"
   ]
  }
 },
 {
  "id": "booking.reservas.comercial",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "comercial",
    "direccion"
   ]
  }
 },
 {
  "id": "booking.reservas.prisa",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "comercial"
   ]
  }
 },
 {
  "id": "booking.reservas.papelera",
  "frequency": "rare_critical",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina"
   ]
  }
 },
 {
  "id": "booking.reserva.cabecera",
  "frequency": "frequent",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina",
    "comercial"
   ]
  }
 },
 {
  "id": "booking.reserva.fechas",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "comercial"
   ]
  }
 },
 {
  "id": "booking.reserva.propuesta",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "comercial"
   ]
  }
 },
 {
  "id": "booking.reserva.alojamiento",
  "frequency": "frequent",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina"
   ]
  }
 },
 {
  "id": "booking.reserva.ses",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina"
   ]
  }
 },
 {
  "id": "booking.reserva.portal",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina"
   ]
  }
 },
 {
  "id": "booking.reserva.montaje",
  "frequency": "occasional",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina"
   ]
  }
 },
 {
  "id": "booking.reserva.flow_listo",
  "frequency": "occasional",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina"
   ]
  }
 },
 {
  "id": "booking.reserva.personal",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina"
   ]
  }
 },
 {
  "id": "booking.reserva.abierto",
  "frequency": "occasional",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina"
   ]
  }
 },
 {
  "id": "booking.reserva.alacarta",
  "frequency": "frequent",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "recepcion"
   ]
  }
 },
 {
  "id": "booking.reserva.barra",
  "frequency": "frequent",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "recepcion"
   ]
  }
 },
 {
  "id": "booking.reserva.visitantes",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "recepcion",
    "oficina"
   ]
  }
 },
 {
  "id": "booking.reserva.qr",
  "frequency": "occasional",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina"
   ]
  }
 },
 {
  "id": "booking.reserva.peticiones",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina"
   ]
  }
 },
 {
  "id": "booking.reserva.extracto",
  "frequency": "occasional",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina",
    "direccion"
   ]
  }
 },
 {
  "id": "booking.reserva.confirmacion_rechazada",
  "frequency": "rare_critical",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina"
   ]
  }
 },
 {
  "id": "booking.recepcion",
  "frequency": "frequent",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "recepcion"
   ]
  }
 },
 {
  "id": "booking.recepcion.buscar",
  "frequency": "frequent",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "recepcion"
   ]
  }
 },
 {
  "id": "booking.recepcion.cobrar",
  "frequency": "frequent",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "recepcion"
   ]
  }
 },
 {
  "id": "booking.recepcion.metodo",
  "frequency": "frequent",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "recepcion"
   ]
  }
 },
 {
  "id": "booking.recepcion.alojar_pagado",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "recepcion"
   ]
  }
 },
 {
  "id": "booking.recepcion.llega",
  "frequency": "frequent",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "recepcion"
   ]
  }
 },
 {
  "id": "booking.recepcion.sale",
  "frequency": "frequent",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "recepcion"
   ]
  }
 },
 {
  "id": "booking.recepcion.ficha",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "recepcion"
   ]
  }
 },
 {
  "id": "booking.recepcion.descartar",
  "frequency": "occasional",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "recepcion"
   ]
  }
 },
 {
  "id": "booking.huespedes.lista",
  "frequency": "frequent",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina",
    "recepcion"
   ]
  }
 },
 {
  "id": "booking.huespedes.registro",
  "frequency": "frequent",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "recepcion"
   ]
  }
 },
 {
  "id": "booking.huespedes.completitud",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina"
   ]
  }
 },
 {
  "id": "booking.huespedes.ses_datos",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina",
    "recepcion"
   ]
  }
 },
 {
  "id": "booking.huespedes.cola_ses",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina"
   ]
  }
 },
 {
  "id": "booking.huespedes.firma",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "recepcion"
   ]
  }
 },
 {
  "id": "booking.huespedes.firma_ver",
  "frequency": "occasional",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina"
   ]
  }
 },
 {
  "id": "booking.huespedes.nuevo_huesped",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "recepcion",
    "oficina"
   ]
  }
 },
 {
  "id": "booking.huespedes.recordatorio_organizador",
  "frequency": "occasional",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina"
   ]
  }
 },
 {
  "id": "booking.huespedes.recuentos",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina",
    "direccion"
   ]
  }
 },
 {
  "id": "booking.huespedes.evento",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ]
  }
 },
 {
  "id": "booking.huespedes.papelera",
  "frequency": "rare_critical",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina"
   ]
  }
 },
 {
  "id": "booking.ses.bandeja",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina"
   ]
  }
 },
 {
  "id": "booking.ses.comunicar_todas",
  "frequency": "occasional",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina"
   ]
  }
 },
 {
  "id": "booking.ses.ajustes",
  "frequency": "rare_critical",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "direccion"
   ]
  }
 },
 {
  "id": "booking.ses.servicio",
  "frequency": "rare_critical",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "direccion"
   ]
  }
 },
 {
  "id": "booking.ses.vias",
  "frequency": "rare_critical",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "direccion"
   ]
  }
 },
 {
  "id": "booking.calendario.mes",
  "frequency": "frequent",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina",
    "comercial",
    "direccion"
   ]
  }
 },
 {
  "id": "booking.calendario.capas",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ]
  }
 },
 {
  "id": "booking.calendario.bloqueos",
  "frequency": "occasional",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "direccion"
   ]
  }
 },
 {
  "id": "booking.calendario.fines",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "comercial"
   ]
  }
 },
 {
  "id": "booking.calendario.google",
  "frequency": "rare_critical",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "direccion"
   ]
  }
 },
 {
  "id": "booking.propuesta.editor",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "comercial"
   ]
  }
 },
 {
  "id": "booking.propuesta.lineas",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "comercial"
   ]
  }
 },
 {
  "id": "booking.propuesta.totales",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "comercial"
   ]
  }
 },
 {
  "id": "booking.propuesta.documento",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "comercial"
   ]
  }
 },
 {
  "id": "booking.propuesta.acciones",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "comercial"
   ]
  }
 },
 {
  "id": "booking.tarifas.tarifario",
  "frequency": "occasional",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "direccion",
    "comercial"
   ]
  }
 },
 {
  "id": "booking.tarifas.caso",
  "frequency": "occasional",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "comercial"
   ]
  }
 },
 {
  "id": "booking.tarifas.condiciones",
  "frequency": "occasional",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "direccion"
   ]
  }
 },
 {
  "id": "booking.tarifas.organizador",
  "frequency": "occasional",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "comercial"
   ]
  }
 },
 {
  "id": "booking.espacios.lista",
  "frequency": "occasional",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "direccion",
    "oficina"
   ]
  }
 },
 {
  "id": "booking.espacios.ficha",
  "frequency": "occasional",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "direccion"
   ]
  }
 },
 {
  "id": "booking.espacios.camas",
  "frequency": "occasional",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "direccion",
    "oficina"
   ]
  }
 },
 {
  "id": "booking.espacios.dormitorio",
  "frequency": "occasional",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "direccion"
   ]
  }
 },
 {
  "id": "booking.espacios.zonas",
  "frequency": "rare_critical",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "direccion"
   ]
  }
 },
 {
  "id": "booking.estancias.proximas",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina"
   ]
  }
 },
 {
  "id": "booking.estancias.calendario",
  "frequency": "normal",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina"
   ]
  }
 },
 {
  "id": "booking.estancias.nueva",
  "frequency": "occasional",
  "audience": {
   "kinds": [
    "staff"
   ],
   "roles": [
    "oficina"
   ]
  }
 },
 {
  "id": "booking.estancias.notas",
  "frequency": "occasional",
  "audience": {
   "kinds": [
    "staff"
   ]
  }
 },
 {
  "id": "booking.pendientes.conflictos",
  "frequency": "rare_critical",
  "audience": {
   "kinds": [
    "staff"
   ]
  }
 },
 {
  "id": "booking.pendientes.rechazados",
  "frequency": "rare_critical",
  "audience": {
   "kinds": [
    "staff"
   ]
  }
 },
 {
  "id": "booking.avisos.error_local",
  "frequency": "rare_critical",
  "audience": {
   "kinds": [
    "staff"
   ]
  }
 }
]$uso$::jsonb);
