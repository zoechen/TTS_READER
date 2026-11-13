FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential git cmake pkg-config \
    libssl-dev libcurl4-openssl-dev libzip-dev libpugixml-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# NOTE: libgourou upstream; pin a tag for reproducible builds
RUN git clone https://forge.soutade.fr/soutade/libgourou.git /tmp/libgourou && \
    cd /tmp/libgourou && make && make install && ldconfig && \
    rm -rf /tmp/libgourou

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

VOLUME ["/root/.config/adept"]
EXPOSE 8000
ENV PYTHONUNBUFFERED=1
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
