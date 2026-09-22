//! Inherited-pipe transport: no listening socket, credentials, shell, or global app discovery.
use crate::{MAX_MESSAGE, Request, Response};
use std::{
    io::{self, BufRead, Read, Write},
    sync::mpsc,
};

pub struct Pending {
    pub request: Request,
    reply: mpsc::SyncSender<Response>,
}
impl Pending {
    pub fn reply(self, response: Response) {
        let _ = self.reply.send(response);
    }
}

/// The host polls on its UI executor. EOF/disconnection means the owned test session must close.
/// All blocking pipe I/O stays off the UI thread. At most one command is outstanding.
pub fn stdio() -> mpsc::Receiver<Pending> {
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let input = io::stdin();
        let output = io::stdout();
        let mut input = input.lock();
        let mut output = output.lock();
        loop {
            let mut bytes = Vec::new();
            match io::Read::by_ref(&mut input)
                .take(MAX_MESSAGE + 1)
                .read_until(b'\n', &mut bytes)
            {
                Ok(0) | Err(_) => break,
                Ok(_) if bytes.len() as u64 > MAX_MESSAGE || !bytes.ends_with(b"\n") => break,
                Ok(_) => {}
            }
            let request: Request = match serde_json::from_slice(&bytes) {
                Ok(request) => request,
                Err(_) => break,
            };
            let (reply, response) = mpsc::sync_channel(1);
            if sender.send(Pending { request, reply }).is_err() {
                break;
            }
            let Ok(response) = response.recv() else {
                break;
            };
            if serde_json::to_writer(&mut output, &response).is_err()
                || output.write_all(b"\n").is_err()
                || output.flush().is_err()
            {
                break;
            }
        }
    });
    receiver
}
