# SES.HOSPEDAJES · documentación oficial

Copia literal de los XSD y el WSDL publicados por el Ministerio del Interior (Secretaría de Estado de Seguridad) para el servicio web de comunicaciones de SES.HOSPEDAJES, versión técnica 3.1.3 (08-01-2025). Documentación pública para integradores, sin datos personales. Si los XSD y el PDF discrepan, mandan los XSD.

- `fnmt-ac-componentes.pem`: certificado intermedio público «AC Componentes Informáticos» de la FNMT (`http://www.cert.fnmt.es/certs/ACCOMP.crt`, válido hasta el 24-6-2028). Los servidores de SES no lo envían en el saludo TLS y el cliente debe añadirlo a su confianza (`docs/booking/API.md` §17.3).

Los usa Booking (`supabase/functions/_domain/booking/ses/`) y sus pruebas.
