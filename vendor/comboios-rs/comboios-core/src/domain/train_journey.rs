use std::sync::OnceLock;

use crate::domain::{
    cp_types::CpTrainTimetable,
    journey::{JourneyStatus, JourneyStop, StopStatus, TrainJourney},
    station::Station,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpTrainJourneyWrapper {
    pub response: IpTrainJourneyResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpTrainJourneyResponse {
    #[serde(alias = "DataHoraDestino")]
    pub destination_time: String,
    #[serde(alias = "DataHoraOrigem")]
    pub origin_time: String,
    #[serde(alias = "Destino")]
    pub destination: String,
    #[serde(alias = "DuracaoViagem")]
    pub duration: String,
    #[serde(alias = "NodesPassagemComboio")]
    pub stops: Vec<TrainPassage>,
    #[serde(alias = "Operador")]
    pub operator: String,
    #[serde(alias = "Origem")]
    pub origin: String,
    #[serde(alias = "SituacaoComboio")]
    pub status: String,
    #[serde(alias = "TipoServico")]
    pub service_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrainPassage {
    #[serde(alias = "ComboioPassou")]
    pub has_passed: bool,
    #[serde(alias = "HoraProgramada")]
    pub scheduled_time: String,
    #[serde(alias = "NodeID")]
    pub node_id: u32,
    #[serde(alias = "NomeEstacao")]
    pub station_name: String,
    #[serde(alias = "Observacoes")]
    pub observations: String,
}

static PREDICTED_TIME_RE: OnceLock<regex::Regex> = OnceLock::new();
static DELAY_STATUS_RE: OnceLock<regex::Regex> = OnceLock::new();

/// # Panics
///
/// Never panics — the regex pattern is a compile-time constant and is always valid.
fn parse_predicted_time(observations: &str) -> Option<String> {
    if observations.is_empty() {
        return None;
    }

    let re = PREDICTED_TIME_RE
        .get_or_init(|| regex::Regex::new(r"Hora Prevista:(\d{2}:\d{2})").unwrap());
    re.captures(observations)
        .map(|c| c.get(1).unwrap().as_str().to_string())
}

fn calculate_delay_from_predicted(scheduled: &str, predicted: &str) -> Option<i32> {
    let parse_time = |t: &str| -> Option<(u32, u32)> {
        let parts: Vec<&str> = t.split(':').collect();
        if parts.len() >= 2 {
            let hours: u32 = parts[0].parse().ok()?;
            let mins: u32 = parts[1].parse().ok()?;
            Some((hours, mins))
        } else {
            None
        }
    };

    let scheduled_mins = parse_time(scheduled).map(|(h, m)| h * 60 + m)?;
    let predicted_mins = parse_time(predicted).map(|(h, m)| h * 60 + m)?;

    let delay = i32::try_from(predicted_mins).ok()? - i32::try_from(scheduled_mins).ok()?;
    if delay > 0 { Some(delay) } else { Some(0) }
}

/// # Panics
///
/// Never panics — the regex pattern is a compile-time constant and is always valid.
fn parse_delay_from_status(status: &str) -> Option<i32> {
    if status.is_empty() {
        return None;
    }

    let re = DELAY_STATUS_RE
        .get_or_init(|| regex::Regex::new(r"Circula com atraso de (\d+) min").unwrap());
    re.captures(status)
        .and_then(|c| c.get(1))
        .and_then(|d| d.as_str().parse::<i32>().ok())
}

impl IpTrainJourneyResponse {
    pub fn to_train_journey(&self, train_number: &str) -> TrainJourney {
        let now = crate::lisbon_now();
        let current_time = now.format("%H:%M").to_string();

        let stops: Vec<JourneyStop> = self
            .stops
            .iter()
            .enumerate()
            .map(|(i, p)| {
                let predicted_time = parse_predicted_time(&p.observations);
                let delay = predicted_time
                    .as_ref()
                    .and_then(|pred| calculate_delay_from_predicted(&p.scheduled_time, pred));

                let stop_time = &p.scheduled_time;
                let is_past = stop_time < &current_time && stop_time != "00:00";

                let status = if p.has_passed {
                    StopStatus::Passed
                } else if is_past && i != 0 {
                    StopStatus::AtStop
                } else {
                    StopStatus::Scheduled
                };

                JourneyStop {
                    station: Station {
                        code: p.node_id.to_string(),
                        designation: p.station_name.clone(),
                    },
                    scheduled_arrival: p.scheduled_time.clone(),
                    scheduled_departure: p.scheduled_time.clone(),
                    actual_arrival: None,
                    actual_departure: None,
                    platform: None,
                    status,
                    delay_minutes: delay,
                    stop_number: i + 1,
                    has_passed: Some(p.has_passed || is_past),
                    predicted_time,
                }
            })
            .collect();

        TrainJourney {
            train_number: train_number.to_string(),
            service_type: self.service_type.clone(),
            origin: Station {
                code: String::new(),
                designation: self.origin.clone(),
            },
            destination: Station {
                code: String::new(),
                designation: self.destination.clone(),
            },
            stops,
            status: JourneyStatus::Scheduled,
            delay_minutes: parse_delay_from_status(&self.status),
            operator: self.operator.clone(),
            observations: Some(self.status.clone()),
            duration: None,
        }
    }
}

impl CpTrainTimetable {
    pub fn to_train_journey(&self) -> TrainJourney {
        let last_passed_idx = self
            .last_station_code
            .as_ref()
            .and_then(|code| {
                self.train_stops
                    .iter()
                    .position(|s| &s.station.code == code)
            })
            .or_else(|| {
                // Fallback: infer from eta/etd when last_station_code is not
                // provided by the API. Stops with actual arrival or departure
                // times are considered passed.
                self.train_stops
                    .iter()
                    .enumerate()
                    .rfind(|(_, s)| s.eta.is_some() || s.etd.is_some())
                    .map(|(i, _)| i)
            });

        let train_in_progress = self.status != "SCHEDULED" || last_passed_idx.is_some();
        let all_passed = self.status == "PASSED" || self.status == "ARRIVED";

        let stops: Vec<JourneyStop> = self
            .train_stops
            .iter()
            .enumerate()
            .map(|(i, stop)| {
                let scheduled_departure = stop.departure.clone().or(stop.arrival.clone());
                let scheduled_arrival = stop.arrival.clone().or(stop.departure.clone());
                let actual_arrival = stop.eta.clone();
                let actual_departure = stop.etd.clone();

                let has_passed = last_passed_idx.map_or(all_passed, |last_idx| i <= last_idx);

                let status = if !train_in_progress && i == 0 {
                    StopStatus::Scheduled
                } else if has_passed {
                    if i == 0 {
                        StopStatus::Departed
                    } else if Some(i) == last_passed_idx
                        && actual_arrival.is_some()
                        && actual_departure.is_none()
                    {
                        StopStatus::AtStop
                    } else {
                        StopStatus::Passed
                    }
                } else {
                    StopStatus::Scheduled
                };

                JourneyStop {
                    station: Station {
                        code: stop.station.code.clone(),
                        designation: stop.station.designation.clone(),
                    },
                    scheduled_arrival: scheduled_arrival.unwrap_or_default(),
                    scheduled_departure: scheduled_departure.unwrap_or_default(),
                    actual_arrival,
                    actual_departure,
                    platform: stop.platform.clone(),
                    status,
                    delay_minutes: stop.delay,
                    stop_number: i + 1,
                    has_passed: Some(has_passed),
                    predicted_time: if stop.eta.is_some()
                        && stop.delay.is_some()
                        && stop.delay.unwrap_or(0) > 0
                    {
                        stop.eta.clone()
                    } else {
                        None
                    },
                }
            })
            .collect();

        let origin = self.train_stops.first().map_or(
            Station {
                code: String::new(),
                designation: String::new(),
            },
            |s| Station {
                code: s.station.code.clone(),
                designation: s.station.designation.clone(),
            },
        );

        let destination = self.train_stops.last().map_or(
            Station {
                code: String::new(),
                designation: String::new(),
            },
            |s| Station {
                code: s.station.code.clone(),
                designation: s.station.designation.clone(),
            },
        );

        let journey_status = if self.status == "PASSED" || self.status == "ARRIVED" {
            JourneyStatus::Completed
        } else if self.status == "NEAR_NEXT"
            || self.status == "AT_STATION"
            || last_passed_idx.is_some()
        {
            JourneyStatus::InProgress
        } else {
            JourneyStatus::Scheduled
        };

        TrainJourney {
            train_number: self.train_number.to_string(),
            service_type: format!(
                "{}|{}",
                self.service_code.code, self.service_code.designation
            ),
            origin,
            destination,
            stops,
            status: journey_status,
            delay_minutes: self.delay,
            operator: "CP".to_string(),
            observations: None,
            duration: self.duration.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_delay_parsing() {
        assert_eq!(
            parse_delay_from_status("Circula com atraso de 15 min."),
            Some(15)
        );
        assert_eq!(parse_delay_from_status(""), None);
        assert_eq!(parse_delay_from_status("No delays"), None);
    }
}
