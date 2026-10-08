use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct FileResult {
    pub name: String,
    pub path: String,
    pub parent: String,
    pub kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResponse {
    pub request_id: u64,
    pub items: Vec<FileResult>,
    pub notice: Option<String>,
}
