use std::time::Duration;

use reqwest::Client;

use crate::constants::{IP_BASE_URL, USER_AGENT};
use crate::domain::{
    journey::TrainJourney, station::StationResponse, station_timetable::StationBoardResponse,
    train_journey::IpTrainJourneyWrapper,
};
use crate::error::CoreError;

#[derive(Clone)]
pub struct IpAdapter {
    client: Client,
    base_url: String,
}

impl IpAdapter {
    pub fn new() -> Self {
        Self::with_url(IP_BASE_URL)
    }

    pub fn with_url(base_url: &str) -> Self {
        Self {
            client: Client::new(),
            base_url: base_url.to_string(),
        }
    }

    #[allow(dead_code)]
    pub async fn search_stations(&self, query: &str) -> Result<StationResponse, CoreError> {
        if query.trim().is_empty() {
            return Err(CoreError::InvalidInput(
                "station search query must not be empty".to_string(),
            ));
        }

        let url = format!(
            "{}/negocios-e-servicos/estacao-nome/{}",
            self.base_url,
            urlencoding::encode(query)
        );

        self.get(url).await
    }

    #[allow(dead_code)]
    pub async fn get_station_timetable(
        &self,
        station_id: &str,
        date: &str,
        is_departure: bool,
    ) -> Result<StationBoardResponse, CoreError> {
        if station_id.trim().is_empty() {
            return Err(CoreError::InvalidInput(
                "station_id must not be empty".to_string(),
            ));
        }

        let direction = if is_departure { "partidas" } else { "chegadas" };
        let url = format!(
            "{}/negocios-e-servicos/partidas-chegadas/{}/{}/{}",
            self.base_url,
            station_id,
            urlencoding::encode(date),
            direction,
        );

        self.get(url).await
    }

    pub async fn get_train_journey(
        &self,
        train_number: &str,
        date: &str,
    ) -> Result<Option<TrainJourney>, CoreError> {
        let url = format!(
            "{}/negocios-e-servicos/horarios-ncombio/{}/{}",
            self.base_url,
            train_number,
            urlencoding::encode(date)
        );

        match self.get::<IpTrainJourneyWrapper>(url).await {
            Ok(wrapper) => Ok(Some(wrapper.response.to_train_journey(train_number))),
            Err(CoreError::ApiError { status: 404, .. }) => Ok(None),
            Err(e) => Err(e),
        }
    }

    async fn get<T: serde::de::DeserializeOwned>(&self, url: String) -> Result<T, CoreError> {
        let response = self
            .client
            .get(&url)
            .timeout(Duration::from_secs(30))
            .header("User-Agent", USER_AGENT)
            .send()
            .await?;

        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(CoreError::ApiError {
                status: status.as_u16(),
                message: text,
            });
        }

        let data = response.json::<T>().await?;
        Ok(data)
    }
}

impl Default for IpAdapter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use wiremock::matchers::{method, path_regex};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::IpAdapter;
    use crate::error::CoreError;

    // --- search_stations ---

    #[tokio::test]
    async fn search_stations_returns_matching_stations() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path_regex(r".*/estacao-nome/Lisboa.*"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "response": [
                    {"NodeID": "9431039", "Nome": "Lisboa Oriente"},
                    {"NodeID": "9430007", "Nome": "Lisboa Santa Apolonia"}
                ]
            })))
            .mount(&mock_server)
            .await;

        let ip = IpAdapter::with_url(&mock_server.uri());
        let result = ip.search_stations("Lisboa").await.unwrap();

        assert_eq!(result.response.len(), 2);
        assert_eq!(result.response[0].code, "9431039");
        assert_eq!(result.response[0].designation, "Lisboa Oriente");
    }

    #[tokio::test]
    async fn search_stations_empty_query_returns_invalid_input() {
        let ip = IpAdapter::with_url("http://unused");
        let err = ip.search_stations("").await.unwrap_err();

        assert!(
            matches!(err, CoreError::InvalidInput(_)),
            "expected InvalidInput, got {err:?}"
        );
    }

    #[tokio::test]
    async fn search_stations_whitespace_query_returns_invalid_input() {
        let ip = IpAdapter::with_url("http://unused");
        let err = ip.search_stations("   ").await.unwrap_err();

        assert!(
            matches!(err, CoreError::InvalidInput(_)),
            "expected InvalidInput, got {err:?}"
        );
    }

    #[tokio::test]
    async fn search_stations_server_error_returns_api_error() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path_regex(r".*/estacao-nome/.*"))
            .respond_with(ResponseTemplate::new(500).set_body_string("Internal Server Error"))
            .mount(&mock_server)
            .await;

        let ip = IpAdapter::with_url(&mock_server.uri());
        let err = ip.search_stations("Porto").await.unwrap_err();

        assert!(
            matches!(err, CoreError::ApiError { status: 500, .. }),
            "expected ApiError(500), got {err:?}"
        );
    }

    // --- get_station_timetable ---

    #[tokio::test]
    async fn get_station_timetable_returns_board() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path_regex(r".*/partidas-chegadas/.*"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "response": [
                    {
                        "station_id": "9431039",
                        "station_name": "Lisboa Oriente",
                        "trains": []
                    }
                ]
            })))
            .mount(&mock_server)
            .await;

        let ip = IpAdapter::with_url(&mock_server.uri());
        let result = ip
            .get_station_timetable("9431039", "2024-01-01", true)
            .await
            .unwrap();

        assert_eq!(result.response.len(), 1);
        assert_eq!(result.response[0].station_name, "Lisboa Oriente");
    }

    #[tokio::test]
    async fn get_station_timetable_empty_station_id_returns_invalid_input() {
        let ip = IpAdapter::with_url("http://unused");
        let err = ip
            .get_station_timetable("", "2024-01-01", true)
            .await
            .unwrap_err();

        assert!(
            matches!(err, CoreError::InvalidInput(_)),
            "expected InvalidInput, got {err:?}"
        );
    }

    // --- get_train_journey ---

    #[tokio::test]
    async fn get_train_journey_not_found_returns_ok_none() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path_regex(r".*/horarios-ncombio/.*"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&mock_server)
            .await;

        let ip = IpAdapter::with_url(&mock_server.uri());
        let result = ip.get_train_journey("999", "2024-01-01").await.unwrap();

        assert!(result.is_none(), "expected None for 404, got {result:?}");
    }

    #[tokio::test]
    async fn get_train_journey_returns_journey() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path_regex(r".*/horarios-ncombio/.*"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "response": {
                    "DataHoraDestino": "2024-01-01 15:30",
                    "DataHoraOrigem": "2024-01-01 12:00",
                    "Destino": "Lisboa Oriente",
                    "DuracaoViagem": "03:30",
                    "NodesPassagemComboio": [
                        {
                            "ComboioPassou": false,
                            "HoraProgramada": "12:00",
                            "NodeID": 9431039,
                            "NomeEstacao": "Porto Campanha",
                            "Observacoes": ""
                        },
                        {
                            "ComboioPassou": false,
                            "HoraProgramada": "15:30",
                            "NodeID": 9430007,
                            "NomeEstacao": "Lisboa Oriente",
                            "Observacoes": ""
                        }
                    ],
                    "Operador": "CP",
                    "Origem": "Porto Campanha",
                    "SituacaoComboio": "",
                    "TipoServico": "IC"
                }
            })))
            .mount(&mock_server)
            .await;

        let ip = IpAdapter::with_url(&mock_server.uri());
        let journey = ip
            .get_train_journey("530", "2024-01-01")
            .await
            .unwrap()
            .expect("expected Some(journey)");

        assert_eq!(journey.origin.designation, "Porto Campanha");
        assert_eq!(journey.stops.len(), 2);
    }
}
