// Territorio piloto. Otro territorio = otro archivo como este, sin tocar código.

export const montevideo = {
  slug: "montevideo",
  name: "Montevideo",
  areaLabel: "Barrio",
  center: { lon: -56.1882, lat: -34.9058 },
  defaultZoom: 13,
  locale: "es",
  emergencyChannel: {
    text: "consultá el canal de emergencias local de tu zona.",
  },
  areas: {
    file: "barrios-montevideo.geojson",
    nameProperty: "barrio",
    idProperty: "ogc_fid",
    sourceUrl:
      "https://mapas.ide.uy/geoserver-vectorial/ws_capa_base/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=ws_capa_base%3Abarrios_montevideo&outputFormat=application%2Fjson&srsName=EPSG%3A4326",
    sourceDate: "2026-10-17",
  },
};
